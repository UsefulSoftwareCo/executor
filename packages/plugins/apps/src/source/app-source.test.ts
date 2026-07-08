/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: tests use fixture server cleanup and hard-fail setup errors */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { FLUSH, parseInfoRefs, pktLine, resolveWant } from "../git-client/pktline";
import { handFetch } from "../git-client/hand";
import { parsePack, walkTree } from "../git-client/packfile";
import { authForHost, checkRefs, uploadPack } from "../git-client/transport";
import { PUBLISH_LIMITS } from "../pipeline/publish";
import { checkGitAppSourceRefs, fetchGitAppSource, parseGitSourceUrl } from "./git-source";
import { fetchLocalDirectoryAppSource } from "./local-directory-source";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

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

const gitObjectId = async (type: string, data: Uint8Array): Promise<string> => {
  const header = textEncoder.encode(`${type} ${data.length}\0`);
  const full = concat([header, data]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", full as BufferSource));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const hexBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
};

const packObjectHeader = (type: number, size: number): Uint8Array => {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Uint8Array.from(bytes);
};

const packFile = (objects: readonly Uint8Array[]): Uint8Array => {
  const header = new Uint8Array(12);
  header.set(textEncoder.encode("PACK"), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  return concat([header, ...objects, new Uint8Array(20)]);
};

const packedObject = (type: number, data: Uint8Array): Uint8Array =>
  concat([packObjectHeader(type, data.length), deflateSync(data)]);

const deltaVarint = (value: number): Uint8Array => {
  const bytes: number[] = [];
  do {
    let next = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) next |= 0x80;
    bytes.push(next);
  } while (value > 0);
  return Uint8Array.from(bytes);
};

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

type FetchHandler = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

const testFetch = (handler: FetchHandler): typeof fetch =>
  Object.assign(handler, { preconnect: () => undefined }) as typeof fetch;

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

  it("rejects truncated and malformed pkt-line responses", () => {
    expect(() =>
      parseInfoRefs(concat([pktLine("# service=git-upload-pack\n"), Uint8Array.from([48])])),
    ).toThrow(/truncated pkt-line/);
    expect(() => parseInfoRefs(textEncoder.encode("0002"))).toThrow(/bad pkt-line length/);
  });

  it("rejects truncated upload-pack side-band responses", async () => {
    await expect(
      uploadPack("https://example.test/repo", "1".repeat(40), {
        fetchImpl: testFetch(async () => new Response(textEncoder.encode("0009\u0001PAC"))),
      }),
    ).rejects.toThrow(/truncated upload-pack response/);
  });

  it.effect("rejects private git hosts under cloud posture", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://localhost/repo.git",
        "https://localhost/repo.git",
        "https://127.0.0.1/repo.git",
        "https://[::ffff:127.0.0.1]/repo.git",
        "https://2130706433/repo.git",
        "https://0177.0.0.1/repo.git",
        "https://0x7f.0.0.1/repo.git",
        "https://10.1.2.3/repo.git",
        "https://169.254.1.1/repo.git",
      ]) {
        const exit = yield* Effect.exit(parseGitSourceUrl(url));
        expect(Exit.isFailure(exit)).toBe(true);
      }
      expect(
        yield* parseGitSourceUrl("http://127.0.0.1:9999/repo.git", {
          allowPrivateHosts: true,
        }),
      ).toBeInstanceOf(URL);
      expect(yield* parseGitSourceUrl("https://gitlab.com/acme/tools.git")).toBeInstanceOf(URL);
    }),
  );

  it("rejects redirects to private or non-https git hosts", async () => {
    const exit = await Effect.runPromiseExit(
      checkGitAppSourceRefs({
        url: "https://example.test/repo",
        fetch: testFetch(
          async () =>
            new Response(null, {
              status: 302,
              headers: { location: "http://127.0.0.1/repo.git/info/refs" },
            }),
        ),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("drops the authorization header on cross-host redirects", async () => {
    const seenAuth: Array<string | null> = [];
    const fetchImpl = testFetch(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : "");
      const headers = new Headers(init?.headers);
      seenAuth.push(headers.get("authorization"));
      if (url.hostname === "example.test") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://mirror.test/repo.git/info/refs?service=git-upload-pack" },
        });
      }
      return new Response(
        new Uint8Array(advertisement("1111111111111111111111111111111111111111")),
        {
          headers: { "content-type": "application/x-git-upload-pack-advertisement" },
        },
      );
    });
    const result = await checkRefs(
      "https://example.test/repo",
      { authorization: "Basic secret" },
      fetchImpl,
    );
    expect(result.adv.headTarget).toBe("refs/heads/main");
    expect(seenAuth).toEqual(["Basic secret", null]);
  });

  it("enforces pack expansion caps during parse and delta application", async () => {
    await expect(
      parsePack(packFile([packedObject(3, textEncoder.encode("tiny"))]), {
        limits: { maxObjectBytes: 3 },
      }),
    ).rejects.toThrow(/repository too large/);

    const base = textEncoder.encode("a");
    const baseSha = await gitObjectId("blob", base);
    const delta = concat([deltaVarint(base.length), deltaVarint(1024), Uint8Array.from([1, 120])]);
    const refDelta = concat([
      packObjectHeader(7, delta.length),
      hexBytes(baseSha),
      deflateSync(delta),
    ]);
    await expect(
      parsePack(packFile([packedObject(3, base), refDelta]), {
        limits: { maxDeltaResultBytes: 32 },
      }),
    ).rejects.toThrow(/repository too large/);
  });

  it("rejects truncated packs, oversized varints, and malformed trees", async () => {
    await expect(parsePack(textEncoder.encode("PACK"))).rejects.toThrow(/pack parse error/);
    await expect(
      parsePack(
        packFile([
          Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0]),
        ]),
      ),
    ).rejects.toThrow(/varint is too long/);

    const malformedTree = textEncoder.encode("100644 missing-nul");
    const treeSha = await gitObjectId("tree", malformedTree);
    const commit = textEncoder.encode(`tree ${treeSha}\n\nbad tree\n`);
    const commitSha = await gitObjectId("commit", commit);
    const parsed = await parsePack(
      packFile([packedObject(1, commit), packedObject(2, malformedTree)]),
    );
    expect(() => walkTree(parsed, commitSha)).toThrow(/malformed tree/);
  });

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

  it("does not read symlinks that escape the source root", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    await mkdir(join(root, "tools"));
    await writeFile(join(outside, "secret.ts"), "export default 'secret';");
    await symlink(join(outside, "secret.ts"), join(root, "tools", "secret.ts"));

    const result = await run(fetchLocalDirectoryAppSource({ path: root }));
    expect(result.files).toEqual([]);
    expect(result.skipped).toContainEqual({
      path: "tools/secret.ts",
      reason: "unsupported file type",
    });
  });
});

const mkdtemp = (): Promise<string> =>
  import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "apps-src-")));
