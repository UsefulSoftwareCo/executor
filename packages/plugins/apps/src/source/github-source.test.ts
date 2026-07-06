import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeSelfHostAppsRuntime } from "../plugin/self-host-runtime";
import { makeInMemoryAppsStore, makeTestResolver } from "../testing";
import { PUBLISH_LIMITS } from "../pipeline/publish";
import { scopeAddress } from "../seams/scope-address";
import { fetchGitHubSource, syncGitHubSource } from "./github-source";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const toolSource = (name = "ok"): string => `import { defineTool } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "${name}",
  input: z.object({ value: z.string().default("${name}") }),
  async handler(input) { return { value: input.value }; },
});`;

const makeRuntime = () =>
  makeSelfHostAppsRuntime({
    dataDir: mkdtempSync(join(tmpdir(), "apps-gh-src-")),
    store: makeInMemoryAppsStore(),
    resolver: makeTestResolver({}),
    inMemory: true,
  });

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

interface GitHubTreeFixtureEntry {
  readonly path: string;
  readonly type: string;
  readonly mode?: string;
  readonly content?: string;
  readonly size?: number;
}

const makeGitHubFetch = (input: {
  readonly files: ReadonlyMap<string, string>;
  readonly entries?: readonly GitHubTreeFixtureEntry[];
  readonly upstreamSha?: string;
  readonly treeSha?: string;
}) => {
  const repoPath = "/repos/acme/tools";
  const upstreamSha = input.upstreamSha ?? "commit-1";
  const treeSha = input.treeSha ?? "tree-1";
  const blobBySha = new Map<string, { path: string; content: string }>();
  const treeEntries: readonly GitHubTreeFixtureEntry[] =
    input.entries ??
    [...input.files].map(([path, content]) => ({
      path,
      type: "blob",
      mode: "100644",
      content,
    }));
  let index = 0;
  const shaByPath = new Map<string, string>();
  for (const entry of treeEntries) {
    if (entry.content !== undefined) {
      const sha = `blob-${++index}`;
      shaByPath.set(entry.path, sha);
      blobBySha.set(sha, { path: entry.path, content: entry.content });
    }
  }
  let blobCalls = 0;
  const fetch = (async (rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.pathname === repoPath) return json({ default_branch: "main" });
    if (url.pathname === `${repoPath}/git/ref/heads%2Fmain`) {
      return json({ object: { sha: upstreamSha } });
    }
    if (url.pathname === `${repoPath}/git/commits/${upstreamSha}`) {
      return json({ sha: upstreamSha, tree: { sha: treeSha } });
    }
    if (url.pathname === `${repoPath}/git/trees/${treeSha}`) {
      return json({
        tree: treeEntries.map((entry, entryIndex) => {
          const sha = shaByPath.get(entry.path) ?? `tree-${entryIndex}`;
          return {
            path: entry.path,
            type: entry.type,
            mode: entry.mode,
            sha,
            size: entry.size ?? Buffer.byteLength(entry.content ?? "", "utf8"),
          };
        }),
      });
    }
    const blobPrefix = `${repoPath}/git/blobs/`;
    if (url.pathname.startsWith(blobPrefix)) {
      blobCalls++;
      const sha = decodeURIComponent(url.pathname.slice(blobPrefix.length));
      const blob = blobBySha.get(sha);
      if (!blob) return json({ message: "not found" }, 404);
      return json({
        encoding: "base64",
        content: Buffer.from(blob.content, "utf8").toString("base64"),
      });
    }
    return json({ message: "not found" }, 404);
  }) as typeof globalThis.fetch;
  return {
    fetch,
    blobCalls: () => blobCalls,
  };
};

describe("GitHub custom-tools source", () => {
  it("fetches a repo fileset and publishes provenance, description, and skipped entries", async () => {
    const files = new Map<string, string>([
      [
        "executor.json",
        JSON.stringify({
          $schema: "https://example.test/schema",
          description: "Acme tools",
          ignored: true,
        }),
      ],
      ["tools/hello.ts", toolSource("hello")],
      ["workflows/deferred.ts", "export default {};"],
      ["docs/readme.md", "ignored"],
    ]);
    const github = makeGitHubFetch({ files, upstreamSha: "commit-a" });
    const snapshot = await run(fetchGitHubSource({ repo: "acme/tools", fetch: github.fetch }));
    expect([...snapshot.files.keys()].sort()).toEqual(["executor.json", "tools/hello.ts"]);
    expect(snapshot.skipped).toEqual([
      { path: "workflows/deferred.ts", reason: "not supported yet" },
      { path: "docs/readme.md", reason: "ignored" },
    ]);
    expect(snapshot.description).toBe("Acme tools");

    const host = makeRuntime();
    const result = await run(
      syncGitHubSource({
        runtime: host.runtime,
        scope: "githubTools",
        repo: "acme/tools",
        fetch: github.fetch,
      }),
    );
    expect(result.status).toBe("published");
    expect(result.tools).toEqual(["hello"]);
    expect(result.skipped).toEqual([
      { path: "workflows/deferred.ts", reason: "not supported yet" },
      { path: "docs/readme.md", reason: "ignored" },
    ]);
    const descriptor = await run(host.runtime.getDescriptor("githubTools"));
    expect(descriptor?.description).toBe("Acme tools");
    expect(descriptor?.source).toEqual({
      kind: "github",
      repo: "acme/tools",
      ref: "main",
      upstreamSha: "commit-a",
    });
    await host.close();
  });

  it("reports up-to-date when the upstream commit SHA is unchanged", async () => {
    const github = makeGitHubFetch({
      files: new Map([["tools/hello.ts", toolSource("hello")]]),
      upstreamSha: "same-sha",
    });
    const host = makeRuntime();
    const first = await run(
      syncGitHubSource({
        runtime: host.runtime,
        scope: "githubTools",
        repo: "acme/tools",
        fetch: github.fetch,
      }),
    );
    const second = await run(
      syncGitHubSource({
        runtime: host.runtime,
        scope: "githubTools",
        repo: "acme/tools",
        fetch: github.fetch,
      }),
    );
    expect(first.status).toBe("published");
    expect(second).toEqual({
      status: "up-to-date",
      upstreamSha: "same-sha",
      tools: ["hello"],
      skipped: [],
    });
    await host.close();
  });

  it("rejects oversized trees before fetching blobs", async () => {
    const files = new Map<string, string>();
    for (let i = 0; i < PUBLISH_LIMITS.maxFiles + 1; i++) {
      files.set(`tools/t${i}.ts`, toolSource(`t${i}`));
    }
    const github = makeGitHubFetch({ files });
    const exit = await Effect.runPromiseExit(
      fetchGitHubSource({ repo: "acme/tools", fetch: github.fetch }),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("exceeding the limit");
    expect(github.blobCalls()).toBe(0);
  });

  it("returns typed failure data for publish errors", async () => {
    const github = makeGitHubFetch({
      files: new Map([
        [
          "tools/bad.ts",
          `import { defineTool } from "executor:app";
import { chunk } from "lodash";
export default defineTool({ description: "bad", input: { type: "object" }, async handler(){ return chunk([1], 1); } });`,
        ],
      ]),
      upstreamSha: "bad-sha",
    });
    const host = makeRuntime();
    const result = await run(
      syncGitHubSource({
        runtime: host.runtime,
        scope: "githubTools",
        repo: "acme/tools",
        fetch: github.fetch,
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.upstreamSha).toBe("bad-sha");
    expect(result.errors?.[0]?.stage).toBe("bundle");
    expect(result.errors?.[0]?.message).toContain('bare import "lodash" is not allowed');
    await host.close();
  });

  it("skips unsupported tree entries and invalid paths without committing them", async () => {
    const github = makeGitHubFetch({
      files: new Map(),
      entries: [
        {
          path: "tools/ok.ts",
          type: "blob",
          mode: "100644",
          content: toolSource("ok"),
        },
        {
          path: "tools/link.ts",
          type: "blob",
          mode: "120000",
          content: "../outside.ts",
        },
        {
          path: "tools/submodule.ts",
          type: "commit",
          mode: "160000",
        },
        {
          path: "tools/Bad.Name.ts",
          type: "blob",
          mode: "100644",
          content: toolSource("bad"),
        },
      ],
      upstreamSha: "mixed-sha",
    });
    const host = makeRuntime();
    const result = await run(
      syncGitHubSource({
        runtime: host.runtime,
        scope: "githubTools",
        repo: "acme/tools",
        fetch: github.fetch,
      }),
    );

    expect(result.status).toBe("published");
    expect(result.tools).toEqual(["ok"]);
    expect(result.skipped).toEqual([
      { path: "tools/link.ts", reason: "unsupported file type" },
      { path: "tools/submodule.ts", reason: "unsupported file type" },
      { path: "tools/Bad.Name.ts", reason: "ignored" },
    ]);

    const descriptor = await run(host.runtime.getDescriptor("githubTools"));
    expect(descriptor?.tools.map((tool) => tool.name)).toEqual(["ok"]);
    const scopeStore = await run(
      host.runtime.deps.artifactStore.forScope(scopeAddress("org", "githubTools")),
    );
    const snapshotPaths = await run(scopeStore.list(descriptor!.snapshotId as never));
    expect(snapshotPaths).toContain("tools/ok.ts");
    expect(snapshotPaths).not.toContain("tools/link.ts");
    expect(snapshotPaths).not.toContain("tools/submodule.ts");
    expect(snapshotPaths).not.toContain("tools/Bad.Name.ts");
    await host.close();
  });
});
