/**
 * Git objects, packs and receive-pack requests, written directly. A push sends only the objects it
 * names: unchanged files stay on the server and are never fetched, and every blob streams through
 * compression one at a time, so neither side holds a whole pack or a whole tree of files.
 */
import { Effect, Schema, Stream } from "effect";
import { SourceError } from "@executor-js/sdk/core";

const encoder = new TextEncoder();
const zeroId = "0".repeat(40);

/** Incremental SHA-1. Web Crypto hashes only whole buffers, and packs are hashed as they stream. */
export class Sha1 {
  private readonly state = new Uint32Array([
    0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(80);
  private filled = 0;
  private length = 0;

  update(bytes: Uint8Array) {
    this.length += bytes.length;
    let offset = 0;
    while (offset < bytes.length) {
      const take = Math.min(64 - this.filled, bytes.length - offset);
      this.block.set(bytes.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === 64) {
        this.compress();
        this.filled = 0;
      }
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.length * 8;
    const padding = new Uint8Array(((this.filled < 56 ? 56 : 120) - this.filled) as number);
    padding[0] = 0x80;
    const size = new Uint8Array(8);
    const view = new DataView(size.buffer);
    view.setUint32(0, Math.floor(bits / 0x100000000));
    view.setUint32(4, bits >>> 0);
    this.update(padding);
    this.update(size);
    const out = new Uint8Array(20);
    const result = new DataView(out.buffer);
    for (let index = 0; index < 5; index++) result.setUint32(index * 4, this.state[index] ?? 0);
    return out;
  }

  hex() {
    return Array.from(this.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private compress() {
    const w = this.words;
    const view = new DataView(this.block.buffer);
    for (let index = 0; index < 16; index++) w[index] = view.getUint32(index * 4);
    for (let index = 16; index < 80; index++) {
      const value =
        (w[index - 3] ?? 0) ^ (w[index - 8] ?? 0) ^ (w[index - 14] ?? 0) ^ (w[index - 16] ?? 0);
      w[index] = (value << 1) | (value >>> 31);
    }
    let [a, b, c, d, e] = [
      this.state[0] ?? 0,
      this.state[1] ?? 0,
      this.state[2] ?? 0,
      this.state[3] ?? 0,
      this.state[4] ?? 0,
    ];
    for (let index = 0; index < 80; index++) {
      const [f, k] =
        index < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : index < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : index < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const next = (((a << 5) | (a >>> 27)) + f + e + k + (w[index] ?? 0)) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = next;
    }
    this.state[0] = ((this.state[0] ?? 0) + a) >>> 0;
    this.state[1] = ((this.state[1] ?? 0) + b) >>> 0;
    this.state[2] = ((this.state[2] ?? 0) + c) >>> 0;
    this.state[3] = ((this.state[3] ?? 0) + d) >>> 0;
    this.state[4] = ((this.state[4] ?? 0) + e) >>> 0;
  }
}

export type ObjectType = "commit" | "tree" | "blob";
const typeCode: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3 };

/** A Git object's ID: the SHA-1 of `<type> <size>\0` and its bytes. */
export const objectId = (type: ObjectType, bytes: Uint8Array) =>
  new Sha1()
    .update(encoder.encode(`${type} ${bytes.length}\0`))
    .update(bytes)
    .hex();

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** One entry of a tree: a file (`100644`) or a subtree (`40000`). */
export interface TreeEntry {
  readonly name: string;
  readonly mode: "100644" | "100755" | "40000";
  readonly object: string;
}

/** Git sorts tree entries by name, comparing a subtree's name as if it ended in `/`. */
const sortKey = (entry: TreeEntry) => (entry.mode === "40000" ? `${entry.name}/` : entry.name);

/** The bytes of a tree object. */
export const treeObject = (entries: ReadonlyArray<TreeEntry>) =>
  concat(
    entries
      .toSorted((left, right) => {
        const a = encoder.encode(sortKey(left));
        const b = encoder.encode(sortKey(right));
        for (let index = 0; index < Math.min(a.length, b.length); index++)
          if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
        return a.length - b.length;
      })
      .flatMap((entry) => [encoder.encode(`${entry.mode} ${entry.name}\0`), fromHex(entry.object)]),
  );

/**
 * The tree objects for a complete list of files, deepest first, and the root tree's ID. Paths are
 * canonical source paths, which `SourceFiles` has already checked.
 */
export const buildTrees = (
  files: ReadonlyArray<{ readonly path: string; readonly object: string }>,
) => {
  interface Directory {
    readonly files: Map<string, string>;
    readonly directories: Map<string, Directory>;
  }
  const root: Directory = { files: new Map(), directories: new Map() };
  for (const file of files) {
    const segments = file.path.split("/");
    const name = segments.pop() ?? file.path;
    let directory = root;
    for (const segment of segments) {
      const next = directory.directories.get(segment) ?? {
        files: new Map(),
        directories: new Map(),
      };
      directory.directories.set(segment, next);
      directory = next;
    }
    directory.files.set(name, file.object);
  }
  const trees: Array<{ readonly object: string; readonly bytes: Uint8Array }> = [];
  const write = (directory: Directory): string => {
    const entries: TreeEntry[] = [
      ...[...directory.files].map(([name, object]) => ({ name, mode: "100644" as const, object })),
      ...[...directory.directories].map(([name, child]) => ({
        name,
        mode: "40000" as const,
        object: write(child),
      })),
    ];
    const bytes = treeObject(entries);
    const object = objectId("tree", bytes);
    trees.push({ object, bytes });
    return object;
  };
  const tree = write(root);
  return { tree, trees };
};

/** The bytes of a commit object by Executor, at `seconds` since the epoch. */
export const commitObject = (input: {
  readonly tree: string;
  readonly parents: ReadonlyArray<string>;
  readonly message: string;
  readonly seconds: number;
  readonly author?: { readonly name: string; readonly email: string };
}) => {
  const author = input.author ?? { name: "Executor", email: "apps@executor.local" };
  const signature = `${author.name} <${author.email}> ${input.seconds} +0000`;
  return encoder.encode(
    [
      `tree ${input.tree}`,
      ...input.parents.map((parent) => `parent ${parent}`),
      `author ${signature}`,
      `committer ${signature}`,
      "",
      input.message.endsWith("\n") ? input.message : `${input.message}\n`,
    ].join("\n"),
  );
};

/** One object a pack carries. A blob's bytes are read only when the pack reaches it. */
export interface PackObject {
  readonly type: ObjectType;
  /** The object ID the bytes must hash to; the pack fails rather than send other bytes. */
  readonly object: string;
  readonly size: number;
  readonly read: Effect.Effect<Uint8Array, SourceError>;
}

const objectHeader = (type: ObjectType, size: number) => {
  const bytes: number[] = [];
  let byte = (typeCode[type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return Uint8Array.from(bytes);
};

const deflate = (bytes: Uint8Array) =>
  Stream.fromReadableStream({
    evaluate: () =>
      new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream("deflate")),
    onError: () => new SourceError({ reason: "git" }),
  });

/**
 * A version 2 pack of these objects, each zlib-compressed, ending in the SHA-1 of the pack. Each
 * object is read, checked against its ID and compressed as the stream reaches it.
 */
export const packStream = (objects: ReadonlyArray<PackObject>) => {
  const hash = new Sha1();
  const header = new Uint8Array(12);
  header.set(encoder.encode("PACK"));
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const body = Stream.fromIterable(objects).pipe(
    Stream.flatMap(
      (object) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const bytes = yield* object.read;
            if (bytes.length !== object.size || objectId(object.type, bytes) !== object.object)
              return yield* new SourceError({ reason: "storage" });
            return Stream.concat(
              Stream.succeed(objectHeader(object.type, bytes.length)),
              deflate(bytes),
            );
          }),
        ),
      { concurrency: 1 },
    ),
  );
  return Stream.concat(Stream.succeed(header), body).pipe(
    Stream.tap((chunk) => Effect.sync(() => hash.update(chunk))),
    Stream.concat(Stream.suspend(() => Stream.succeed(hash.digest()))),
  );
};

/** One ref update: `old` and `new` are object IDs; a zero ID creates or deletes the ref. */
export interface RefUpdate {
  readonly ref: string;
  readonly old: string | null;
  readonly new: string | null;
}

const packet = (text: string) => {
  const payload = encoder.encode(text);
  return concat([encoder.encode((payload.length + 4).toString(16).padStart(4, "0")), payload]);
};

/**
 * A receive-pack request body: the ref updates, then the pack when any update writes. Only
 * `report-status` is asked for, so the answer is plain pkt-lines without side-band framing.
 */
export const receivePackBody = (
  updates: ReadonlyArray<RefUpdate>,
  objects: ReadonlyArray<PackObject>,
) => {
  const commands = concat([
    ...updates.map((update, index) =>
      packet(
        `${update.old ?? zeroId} ${update.new ?? zeroId} ${update.ref}${index === 0 ? "\0report-status agent=executor" : ""}\n`,
      ),
    ),
    encoder.encode("0000"),
  ]);
  const writes = updates.some((update) => update.new !== null);
  return writes
    ? Stream.concat(Stream.succeed(commands), packStream(objects))
    : Stream.succeed(commands);
};

/** What the server reported: whether it unpacked, and each ref's `ok` or refusal reason. */
export interface PushReport {
  readonly unpacked: boolean;
  readonly refs: ReadonlyMap<string, "ok" | { readonly refused: string }>;
}

/** Parse a `report-status` answer, with or without side-band framing. */
export const parseReport = (bytes: Uint8Array): Effect.Effect<PushReport, SourceError> =>
  Effect.gen(function* () {
    const lines: string[] = [];
    const read = (input: Uint8Array, banded: boolean) => {
      let offset = 0;
      const nested: Uint8Array[] = [];
      while (offset + 4 <= input.length) {
        const length = Number.parseInt(
          new TextDecoder().decode(input.subarray(offset, offset + 4)),
          16,
        );
        if (!Number.isFinite(length)) return false;
        if (length === 0) {
          offset += 4;
          continue;
        }
        const payload = input.subarray(offset + 4, offset + length);
        offset += length;
        if (banded) {
          if (payload[0] === 1) nested.push(payload.subarray(1));
        } else lines.push(new TextDecoder().decode(payload).replace(/\n$/u, ""));
      }
      if (banded) return read(concat(nested), false);
      return true;
    };
    // Side-band frames start with a band byte of 1-3; report lines start with text.
    const first = bytes.length > 4 ? bytes[4] : undefined;
    if (!read(bytes, first === 1 || first === 2 || first === 3))
      return yield* new SourceError({ reason: "git" });
    const unpack = lines.find((line) => line.startsWith("unpack "));
    if (unpack === undefined) return yield* new SourceError({ reason: "git" });
    const refs = new Map<string, "ok" | { readonly refused: string }>();
    for (const line of lines) {
      const ok = /^ok (\S+)$/u.exec(line);
      if (ok?.[1] !== undefined) refs.set(ok[1], "ok");
      const ng = /^ng (\S+) ?(.*)$/u.exec(line);
      if (ng?.[1] !== undefined) refs.set(ng[1], { refused: ng[2] ?? "" });
    }
    return { unpacked: unpack === "unpack ok", refs };
  });

/**
 * A pack carrying more than this many bytes of blobs is split. Cloudflare Artifacts fails a push
 * whose pack reaches about 64 MiB (cloudflare/workers-sdk#14143); 48 MiB leaves room for headers
 * and incompressible files, and a single file of at most 32 MB always fits.
 */
export const packBlobBytes = 48 * 1024 * 1024;

/**
 * Group blobs into batches of at most `packBlobBytes`, keeping their order. Every batch but the
 * last is pushed to a temporary ref first, so the final push stays under the same bound.
 */
export const batchBlobs = <A extends { readonly size: number }>(blobs: ReadonlyArray<A>) => {
  const batches: A[][] = [];
  let current: A[] = [];
  let bytes = 0;
  for (const blob of blobs) {
    if (current.length > 0 && bytes + blob.size > packBlobBytes) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(blob);
    bytes += blob.size;
  }
  batches.push(current);
  return batches;
};

/** The receive-pack request and the report it answers. */
export type ReceivePack = (
  body: Stream.Stream<Uint8Array, SourceError>,
) => Effect.Effect<Uint8Array, SourceError>;

/**
 * Push `final` (a commit and the objects it needs) to `ref`, moving it only from `expected`.
 * Blobs beyond one pack's bound go first to `staging` as a chain of commits whose trees name each
 * blob by its ID; the final push deletes `staging`. Returns the report of the final push.
 */
export const pushObjects = (input: {
  readonly receive: ReceivePack;
  readonly ref: string;
  readonly expected: string | null;
  readonly commit: PackObject;
  readonly trees: ReadonlyArray<PackObject>;
  readonly blobs: ReadonlyArray<PackObject>;
  readonly staging: string;
  readonly seconds: number;
}) =>
  Effect.gen(function* () {
    const batches = batchBlobs(input.blobs);
    const last = batches.pop() ?? [];
    let staged: string | null = null;
    for (const batch of batches) {
      const listing = treeObject(
        batch.map((blob) => ({ name: blob.object, mode: "100644" as const, object: blob.object })),
      );
      const tree = objectId("tree", listing);
      const commitBytes = commitObject({
        tree,
        parents: staged === null ? [] : [staged],
        message: "Upload public files",
        seconds: input.seconds,
      });
      const commit = objectId("commit", commitBytes);
      const report = yield* input
        .receive(
          receivePackBody(
            [{ ref: input.staging, old: staged, new: commit }],
            [
              ...batch,
              { type: "tree", object: tree, size: listing.length, read: Effect.succeed(listing) },
              {
                type: "commit",
                object: commit,
                size: commitBytes.length,
                read: Effect.succeed(commitBytes),
              },
            ],
          ),
        )
        .pipe(Effect.flatMap(parseReport));
      if (!report.unpacked || report.refs.get(input.staging) !== "ok")
        return yield* new SourceError({ reason: "git" });
      staged = commit;
    }
    const report = yield* input
      .receive(
        receivePackBody(
          [
            { ref: input.ref, old: input.expected, new: input.commit.object },
            ...(staged === null ? [] : [{ ref: input.staging, old: staged, new: null }]),
          ],
          [...last, ...input.trees, input.commit],
        ),
      )
      .pipe(Effect.flatMap(parseReport));
    return report;
  });

/** A Git object ID. */
export const ObjectId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
