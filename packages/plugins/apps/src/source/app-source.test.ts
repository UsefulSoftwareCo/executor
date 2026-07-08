/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: tests use fixture server cleanup and hard-fail setup errors */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { FLUSH, parseInfoRefs, pktLine, resolveWant } from "../git-client/pktline";
import { handFetch } from "../git-client/hand";
import { authForHost } from "../git-client/transport";
import { PUBLISH_LIMITS } from "../pipeline/publish";
import { checkGitAppSourceRefs, fetchGitAppSource, parseGitSourceUrl } from "./git-source";
import { fetchLocalDirectoryAppSource } from "./local-directory-source";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const textDecoder = new TextDecoder();

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const sideBand = (bytes: Uint8Array): Uint8Array => {
  const chunks: Uint8Array[] = [pktLine("NAK\n")];
  for (let offset = 0; offset < bytes.length; offset += 60_000) {
    const chunk = bytes.subarray(offset, offset + 60_000);
    const payload = new Uint8Array(chunk.length + 1);
    payload[0] = 1;
    payload.set(chunk, 1);
    chunks.push(pktLine(payload));
  }
  chunks.push(FLUSH);
  return concat(chunks);
};

const advertisement = (sha: string): Uint8Array =>
  concat([
    pktLine("# service=git-upload-pack\n"),
    FLUSH,
    pktLine(
      `${sha} HEAD\0symref=HEAD:refs/heads/main multi_ack side-band-64k thin-pack ofs-delta\n`,
    ),
    pktLine(`${sha} refs/heads/main\n`),
    pktLine(`${sha} refs/tags/v1\n`),
    pktLine(`${sha} refs/tags/v1^{}\n`),
    FLUSH,
  ]);

const readFixture = async () => {
  const dir = join(import.meta.dirname, "fixtures");
  const [shas, pack1, pack2] = await Promise.all([
    readFile(join(dir, "git-fixture-shas.txt"), "utf8"),
    readFile(join(dir, "git-fixture-v1.pack")),
    readFile(join(dir, "git-fixture-v2.pack")),
  ]);
  const [sha1, sha2] = shas.trim().split("\n");
  return { sha1: sha1!, sha2: sha2!, pack1, pack2 };
};

const fixtureServer = async () => {
  const fixture = await readFixture();
  let current = { sha: fixture.sha1, pack: new Uint8Array(fixture.pack1) };
  let packRequests = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === "/repo.git/info/refs?service=git-upload-pack") {
      response.writeHead(200, {
        "content-type": "application/x-git-upload-pack-advertisement",
      });
      response.end(advertisement(current.sha));
      return;
    }
    if (request.url === "/repo.git/git-upload-pack" && request.method === "POST") {
      packRequests += 1;
      response.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
      response.end(sideBand(current.pack));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  return {
    url: `https://example.test/repo`,
    fetch: ((rawUrl: string, init?: RequestInit) => {
      const incoming = new URL(rawUrl);
      const local = new URL(
        `http://127.0.0.1:${address.port}${incoming.pathname}${incoming.search}`,
      );
      return fetch(local, init);
    }) as typeof fetch,
    advance: () => {
      current = { sha: fixture.sha2, pack: new Uint8Array(fixture.pack2) };
    },
    packRequests: () => packRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const liveOrSkip = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
};

describe("git app sources", () => {
  it("parses github and gitlab advertisements", () => {
    const github = parseInfoRefs(advertisement("1111111111111111111111111111111111111111"));
    expect(github.headTarget).toBe("refs/heads/main");
    expect(github.refs.get("refs/tags/v1^{}")).toBe("1111111111111111111111111111111111111111");
    expect(resolveWant(github).resolvedRef).toBe("refs/heads/main");

    const gitlab = parseInfoRefs(
      concat([
        pktLine("# service=git-upload-pack\n"),
        FLUSH,
        pktLine(
          "2222222222222222222222222222222222222222 HEAD\0symref=HEAD:refs/heads/master multi_ack side-band-64k thin-pack ofs-delta\n",
        ),
        pktLine("2222222222222222222222222222222222222222 refs/heads/master\n"),
        pktLine("3333333333333333333333333333333333333333 refs/tags/v1\n"),
        pktLine("2222222222222222222222222222222222222222 refs/tags/v1^{}\n"),
        FLUSH,
      ]),
    );
    expect(resolveWant(gitlab).resolvedRef).toBe("refs/heads/master");
    expect(resolveWant(gitlab, "v1").sha).toBe("3333333333333333333333333333333333333333");
  });

  it("uses host-specific auth recipes", () => {
    expect(authForHost("github.com", "t").authorization).toBe(`Basic ${btoa("x-access-token:t")}`);
    expect(authForHost("gitlab.com", "t").authorization).toBe(`Basic ${btoa("oauth2:t")}`);
    expect(authForHost("bitbucket.org", "t").authorization).toBe(`Basic ${btoa("x-token-auth:t")}`);
    expect(authForHost("codeberg.org", "t").authorization).toBe(`Basic ${btoa("git:t")}`);
  });

  it.effect("rejects private git hosts under cloud posture", () =>
    Effect.gen(function* () {
      for (const url of [
        "https://localhost/repo.git",
        "https://127.0.0.1/repo.git",
        "https://10.1.2.3/repo.git",
        "https://169.254.1.1/repo.git",
      ]) {
        const exit = yield* Effect.exit(parseGitSourceUrl(url));
        expect(Exit.isFailure(exit)).toBe(true);
      }
      expect(yield* parseGitSourceUrl("https://gitlab.com/acme/tools.git")).toBeInstanceOf(URL);
    }),
  );

  it("fetches a fixture git repo and avoids pack download when the sha is unchanged", async () => {
    const server = await fixtureServer();
    try {
      const firstRefs = await run(
        checkGitAppSourceRefs({
          url: server.url,
          fetch: server.fetch,
          allowPrivateHosts: true,
        }),
      );
      const first = await run(
        fetchGitAppSource({
          url: server.url,
          fetch: server.fetch,
          allowPrivateHosts: true,
        }),
      );
      expect(first.sourceRef).toBe(firstRefs.sourceRef);
      expect(first.files.map((file) => file.path).sort()).toEqual([
        "executor.json",
        "tools/greeter.ts",
      ]);
      expect(server.packRequests()).toBe(1);

      const unchanged = await run(
        checkGitAppSourceRefs({
          url: server.url,
          fetch: server.fetch,
          allowPrivateHosts: true,
        }),
      );
      expect(unchanged.sourceRef).toBe(first.sourceRef);
      expect(server.packRequests()).toBe(1);

      server.advance();
      const second = await run(
        fetchGitAppSource({
          url: server.url,
          fetch: server.fetch,
          allowPrivateHosts: true,
        }),
      );
      expect(second.sourceRef).not.toBe(first.sourceRef);
      expect(
        textDecoder.decode(second.files.find((file) => file.path === "tools/greeter.ts")?.bytes),
      ).toContain("Greeting v2");
      expect(server.packRequests()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("surfaces oversized packfiles as source failures", async () => {
    const server = await fixtureServer();
    try {
      const exit = await Effect.runPromiseExit(
        fetchGitAppSource({
          url: server.url,
          fetch: server.fetch,
          allowPrivateHosts: true,
          maxBytes: 32,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("checks live github and gitlab refs when online", async () => {
    if (!(await liveOrSkip("https://github.com"))) return;
    if (!(await liveOrSkip("https://gitlab.com"))) return;
    const github = await run(
      checkGitAppSourceRefs({ url: "https://github.com/octocat/Hello-World" }),
    );
    const gitlab = await run(
      checkGitAppSourceRefs({ url: "https://gitlab.com/gitlab-org/gitlab-test" }),
    );
    expect(github.sourceRef).toMatch(/^[0-9a-f]{40}$/);
    expect(gitlab.sourceRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it("fetches a tiny live public repo when online", async () => {
    if (!(await liveOrSkip("https://github.com"))) return;
    const source = await handFetch("https://github.com/octocat/Hello-World", undefined, {
      maxBytes: PUBLISH_LIMITS.maxTotalBytes,
    });
    expect(source.ok).toBe(true);
    expect(source.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(source.files?.some((file) => file.path.toLowerCase().includes("readme"))).toBe(true);
  });
});

describe("local-directory app sources", () => {
  it("reads local directories and hashes content deterministically", async () => {
    const root = await mkdtemp();
    await mkdir(join(root, "tools"));
    await mkdir(join(root, "workflows"));
    await writeFile(join(root, "executor.json"), JSON.stringify({ description: "Local tools" }));
    await writeFile(join(root, "tools", "hello.ts"), "export default {};");
    await writeFile(join(root, "workflows", "later.ts"), "export default {};");
    await symlink(join(root, "tools", "hello.ts"), join(root, "tools", "link.ts"));

    const first = await run(fetchLocalDirectoryAppSource({ path: root }));
    const second = await run(fetchLocalDirectoryAppSource({ path: root }));
    expect(first.sourceRef).toBe(second.sourceRef);
    expect(first.description).toBe("Local tools");
    expect(first.files.map((file) => file.path).sort()).toEqual([
      "executor.json",
      "tools/hello.ts",
    ]);
    expect(first.skipped).toContainEqual({
      path: "tools/link.ts",
      reason: "unsupported file type",
    });
    expect(first.skipped).toContainEqual({
      path: "workflows/later.ts",
      reason: "not supported yet",
    });
  });

  it("rejects unsafe local-directory paths", async () => {
    const relative = await Effect.runPromiseExit(
      fetchLocalDirectoryAppSource({ path: "relative" }),
    );
    const parent = await Effect.runPromiseExit(
      fetchLocalDirectoryAppSource({ path: "/tmp/../bad" }),
    );
    expect(Exit.isFailure(relative)).toBe(true);
    expect(Exit.isFailure(parent)).toBe(true);
  });
});

const mkdtemp = (): Promise<string> =>
  import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "apps-src-")));
