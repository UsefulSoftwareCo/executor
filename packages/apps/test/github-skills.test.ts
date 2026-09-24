/** GitHub skills load over git smart HTTP and raw files, never the REST API. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { githubSkills } from "../src/skills.ts";
import { parseTreeFetch } from "../src/implementation/git.ts";
import { inflateZlib } from "../src/implementation/inflate.ts";
import type { AppCache } from "../src/contracts/cache.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/github-effect-skills.json", import.meta.url), "utf8"),
) as {
  repo: string;
  commit: string;
  lsRefsMain: string;
  treeFetch: string;
  files: Record<string, string>;
};
const bytes = (base64: string) => Buffer.from(base64, "base64");

/** Serve recorded responses and record each request as "METHOD host command-or-path". */
const recorded = (overrides: { treeFetch?: Buffer; files?: Record<string, string> } = {}) => {
  const requests: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "github.com") {
      const body = new TextDecoder().decode(await request.arrayBuffer());
      const command = /command=(\S+)/.exec(body)?.[1];
      requests.push(`POST github.com ${command}`);
      assert.equal(request.headers.get("git-protocol"), "version=2");
      if (command === "ls-refs") return new Response(new Uint8Array(bytes(fixture.lsRefsMain)));
      return new Response(new Uint8Array(overrides.treeFetch ?? bytes(fixture.treeFetch)));
    }
    requests.push(`GET ${url.hostname} ${url.pathname}`);
    const path = url.pathname.split("/").slice(4).join("/");
    const content = (overrides.files ?? fixture.files)[path];
    return content === undefined ? new Response("", { status: 404 }) : new Response(content);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
};

test("a branch loads from git refs, a blob-less tree fetch and raw files at the commit", async () => {
  const { fetch, requests } = recorded();
  const skills = await githubSkills({ repo: fixture.repo, path: "skills", ref: "main", fetch });
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ["effect-ts", "effect-v3-to-v4"],
  );
  assert.deepEqual(requests.slice(0, 2), ["POST github.com ls-refs", "POST github.com fetch"]);
  assert.deepEqual(requests.slice(2).sort(), [
    `GET raw.githubusercontent.com /${fixture.repo}/${fixture.commit}/skills/effect-ts/SKILL.md`,
    `GET raw.githubusercontent.com /${fixture.repo}/${fixture.commit}/skills/effect-v3-to-v4/SKILL.md`,
  ]);
  assert.ok(requests.every((request) => !request.includes("api.github.com")));
});

/** A minimal in-memory app cache: fresh entries return; misses call the loader and store. */
const memoryCache = () => {
  const entries = new Map<string, unknown>();
  const cache: AppCache = {
    get: async (options) => {
      const key = JSON.stringify(options.key);
      if (!entries.has(key)) {
        const controller = new AbortController();
        entries.set(
          key,
          await options.load({ fetch: globalThis.fetch, signal: controller.signal, cache }),
        );
      }
      return entries.get(key) as never;
    },
    revalidate: () => Promise.reject(new Error("unused")),
    read: () => Promise.reject(new Error("unused")),
    readMany: () => Promise.reject(new Error("unused")),
    write: () => Promise.reject(new Error("unused")),
    invalidate: () => Promise.reject(new Error("unused")),
    forAccount: () => cache,
  };
  return { cache, entries };
};

test("a cached commit skips the tree fetch but still resolves the ref", async () => {
  const { cache, entries } = memoryCache();
  const first = recorded();
  const original = globalThis.fetch;
  // Cache loaders receive their own fetch; route it to the recorded responses.
  globalThis.fetch = first.fetch;
  try {
    await githubSkills({
      repo: fixture.repo,
      path: "skills",
      ref: "main",
      fetch: first.fetch,
      cache,
    });
    assert.equal(entries.size, 1);
    assert.equal(first.requests.filter((request) => request.endsWith(" fetch")).length, 1);
    const second = recorded();
    const skills = await githubSkills({
      repo: fixture.repo,
      path: "skills",
      ref: "main",
      fetch: second.fetch,
      cache,
    });
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["effect-ts", "effect-v3-to-v4"],
    );
    assert.equal(second.requests[0], "POST github.com ls-refs");
    assert.ok(second.requests.every((request) => !request.endsWith(" fetch")));
  } finally {
    globalThis.fetch = original;
  }
});

test("a commit ref skips ref resolution", async () => {
  const { fetch, requests } = recorded();
  await githubSkills({ repo: fixture.repo, path: "skills", ref: fixture.commit, fetch });
  assert.equal(requests[0], "POST github.com fetch");
});

test("a missing ref names the repository and ref", async () => {
  const { fetch } = recorded();
  await assert.rejects(githubSkills({ repo: fixture.repo, ref: "missing", fetch }), {
    _tag: "SkillLoadFailed",
    reason: "source",
    message: `GitHub repository ${fixture.repo} has no branch or tag named missing.`,
  });
});

test("a missing or private repository reports that it has no public repository", async () => {
  const fetch = (async () =>
    new Response("", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="GitHub"' },
    })) as typeof globalThis.fetch;
  await assert.rejects(githubSkills({ repo: "example/missing", fetch }), {
    _tag: "SkillLoadFailed",
    reason: "source",
    message: "GitHub has no public repository named example/missing.",
    status: 401,
  });
});

test("a malformed git response is reported without its content", async () => {
  const { fetch } = recorded({ treeFetch: Buffer.from("0008nope") });
  await assert.rejects(githubSkills({ repo: fixture.repo, ref: fixture.commit, fetch }), {
    _tag: "SkillLoadFailed",
    reason: "request",
    message: "GitHub returned a git response Executor could not read.",
  });
});

// Build a v2 fetch response around a packfile made of the given raw object entries.
const objectId = (type: string, data: Uint8Array) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from(`${type} ${data.byteLength}\0`), data]))
    .digest("hex");
const tree = (entries: Array<[mode: string, name: string, id: string]>) =>
  Buffer.concat(
    entries.map(([mode, name, id]) =>
      Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex")]),
    ),
  );
const header = (code: number, size: number) => {
  const out = [(code << 4) | (size & 15) | (size > 15 ? 0x80 : 0)];
  for (let rest = size >> 4; rest > 0; rest >>= 7)
    out.push((rest & 0x7f) | (rest > 0x7f ? 0x80 : 0));
  return Buffer.from(out);
};
const varint = (value: number) => {
  const out: number[] = [];
  do {
    out.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0));
    value >>= 7;
  } while (value > 0);
  return Buffer.from(out);
};
const response = (objects: Buffer[]) => {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length);
  const body = Buffer.concat([Buffer.from("PACK\0\0\0\x02"), count, ...objects]);
  const pack = Buffer.concat([body, createHash("sha1").update(body).digest()]);
  const pkt = (payload: Buffer) =>
    Buffer.concat([Buffer.from((payload.byteLength + 4).toString(16).padStart(4, "0")), payload]);
  return Buffer.concat([
    pkt(Buffer.from("packfile\n")),
    pkt(Buffer.concat([Buffer.from([1]), pack])),
    Buffer.from("0000"),
  ]);
};
const blobId = objectId("blob", Buffer.from("unused"));

test("offset deltas resolve against earlier trees and symbolic links keep their mode", async () => {
  const base = tree([["100644", "SKILL.md", blobId]]);
  const skill = tree([
    ["100644", "SKILL.md", blobId],
    ["120000", "link.md", blobId],
  ]);
  // Delta: copy the whole base, then insert the second entry.
  const insert = skill.subarray(base.byteLength);
  const delta = Buffer.concat([
    varint(base.byteLength),
    varint(skill.byteLength),
    Buffer.from([0x80 | 0x10, base.byteLength]),
    Buffer.from([insert.byteLength]),
    insert,
  ]);
  const skills = tree([["40000", "demo", objectId("tree", skill)]]);
  const root = tree([["40000", "skills", objectId("tree", skills)]]);
  const commit = Buffer.from(`tree ${objectId("tree", root)}\nauthor a <a> 0 +0000\n\nfixture\n`);
  const commitId = objectId("commit", commit);
  const entries = [
    Buffer.concat([header(1, commit.byteLength), deflateSync(commit)]),
    Buffer.concat([header(2, root.byteLength), deflateSync(root)]),
    Buffer.concat([header(2, skills.byteLength), deflateSync(skills)]),
    Buffer.concat([header(2, base.byteLength), deflateSync(base)]),
  ];
  // The delta follows its base, so the distance back is the base entry's size.
  let back = entries[3]!.byteLength;
  const encoded = [back & 0x7f];
  while ((back = Math.floor(back / 128)) > 0) {
    back -= 1;
    encoded.unshift(0x80 | (back & 0x7f));
  }
  entries.push(
    Buffer.concat([header(6, delta.byteLength), Buffer.from(encoded), deflateSync(delta)]),
  );

  const files = await parseTreeFetch(response(entries), commitId, "skills", {
    objectBytes: 1_000_000,
  });
  assert.deepEqual(files, [
    { path: "skills/demo/SKILL.md", mode: "100644" },
    { path: "skills/demo/link.md", mode: "120000" },
  ]);
});

test("inflate reports where each concatenated zlib stream ends", () => {
  for (let index = 0; index < 60; index++) {
    const size = [0, 1, 300, 70_000][index % 4]!;
    const raw = index % 2 === 0 ? randomBytes(size) : Buffer.alloc(size, "abcabcxyz");
    const first = deflateSync(raw, { level: index % 10 });
    const joined = Buffer.concat([first, deflateSync(Buffer.from("tail"))]);
    const one = inflateZlib(joined, 0, 1_000_000);
    const two = inflateZlib(joined, one.end, 1_000_000);
    assert.equal(one.end, first.byteLength);
    assert.deepEqual(Buffer.from(one.data), raw);
    assert.equal(Buffer.from(two.data).toString(), "tail");
  }
});
