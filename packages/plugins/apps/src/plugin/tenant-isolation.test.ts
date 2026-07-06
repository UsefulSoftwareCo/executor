import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeSqliteAppsStore } from "../backing/sqlite-apps-store";
import { scopeAddress } from "../seams/scope-address";
import { syncGitHubSource } from "../source/github-source";
import { makeTestResolver } from "../testing";
import { makeSelfHostAppsRuntime } from "./self-host-runtime";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const toolSource = (name: string): string => `import { defineTool } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "${name}",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  async handler(_input, { db }) {
    await db.sql\`CREATE TABLE IF NOT EXISTS markers (name TEXT NOT NULL)\`;
    await db.sql\`INSERT INTO markers (name) VALUES (${JSON.stringify(name)})\`;
    return { ok: true };
  },
});`;

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeGitHubFetch = (input: { readonly toolName: string; readonly upstreamSha: string }) => {
  const repoPath = "/repos/acme/tools";
  const treeSha = `${input.upstreamSha}-tree`;
  const content = toolSource(input.toolName);
  const fetch = (async (rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.pathname === repoPath) return json({ default_branch: "main" });
    if (url.pathname === `${repoPath}/git/ref/heads%2Fmain`) {
      return json({ object: { sha: input.upstreamSha } });
    }
    if (url.pathname === `${repoPath}/git/commits/${input.upstreamSha}`) {
      return json({ sha: input.upstreamSha, tree: { sha: treeSha } });
    }
    if (url.pathname === `${repoPath}/git/trees/${treeSha}`) {
      return json({
        tree: [
          {
            path: `tools/${input.toolName}.ts`,
            type: "blob",
            mode: "100644",
            sha: `${input.upstreamSha}-blob`,
            size: Buffer.byteLength(content, "utf8"),
          },
        ],
      });
    }
    if (url.pathname === `${repoPath}/git/blobs/${input.upstreamSha}-blob`) {
      return json({
        encoding: "base64",
        content: Buffer.from(content, "utf8").toString("base64"),
      });
    }
    return json({ message: "not found" }, 404);
  }) as typeof globalThis.fetch;
  return fetch;
};

const makeTenantRuntime = (dataDir: string, tenant: string, storePath: string) =>
  makeSelfHostAppsRuntime({
    dataDir,
    tenant,
    store: makeSqliteAppsStore({ path: storePath }),
    resolver: makeTestResolver({}),
  });

describe("tenant scope isolation", () => {
  it("keeps the same source-shaped scope distinct across tenants", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "apps-tenant-"));
    const storePath = join(dataDir, "store.sqlite");
    const scope = "githubSourceSameRepoConnection";
    const tenantA = "org-a";
    const tenantB = "org-b";
    const hostA = makeTenantRuntime(dataDir, tenantA, storePath);
    const hostB = makeTenantRuntime(dataDir, tenantB, storePath);

    const publishedA = await run(
      syncGitHubSource({
        runtime: hostA.runtime,
        tenant: tenantA,
        scope,
        repo: "acme/tools",
        fetch: makeGitHubFetch({ toolName: "alpha", upstreamSha: "sha-a" }),
      }),
    );
    const publishedB = await run(
      syncGitHubSource({
        runtime: hostB.runtime,
        tenant: tenantB,
        scope,
        repo: "acme/tools",
        fetch: makeGitHubFetch({ toolName: "beta", upstreamSha: "sha-b" }),
      }),
    );

    expect(publishedA.status).toBe("published");
    expect(publishedB.status).toBe("published");

    const artifactDirs = readdirSync(join(dataDir, "artifacts")).filter((name) =>
      name.endsWith(".git"),
    );
    expect(artifactDirs.length).toBe(2);

    const descriptorA = await run(hostA.runtime.getDescriptor(tenantA, scope));
    const descriptorB = await run(hostB.runtime.getDescriptor(tenantB, scope));
    expect(descriptorA?.tools.map((tool) => tool.name)).toEqual(["alpha"]);
    expect(descriptorB?.tools.map((tool) => tool.name)).toEqual(["beta"]);

    const dbA = await run(hostA.scopeDb.forScope(scopeAddress(tenantA, scope)));
    const dbB = await run(hostB.scopeDb.forScope(scopeAddress(tenantB, scope)));
    await run(dbA.exec("CREATE TABLE marker (value TEXT)"));
    await run(dbA.exec("INSERT INTO marker (value) VALUES ('a')"));
    await run(dbB.exec("CREATE TABLE marker (value TEXT)"));
    await run(dbB.exec("INSERT INTO marker (value) VALUES ('b')"));
    expect(
      (await run(dbA.exec<{ value: string }>("SELECT value FROM marker"))).map((r) => r.value),
    ).toEqual(["a"]);
    expect(
      (await run(dbB.exec<{ value: string }>("SELECT value FROM marker"))).map((r) => r.value),
    ).toEqual(["b"]);
    expect(
      readdirSync(join(dataDir, "scope-db")).filter((name) => name.endsWith(".db")).length,
    ).toBe(2);

    await hostA.close();
    await hostB.close();
  });
});
