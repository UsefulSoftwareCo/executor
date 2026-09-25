/**
 * Read a public repository's refs and file tree over git's smart HTTP protocol (version 2).
 * These requests do not use the REST API budget that unauthenticated clients share per IP.
 */
import { inflateZlib } from "./inflate.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A malformed git response; callers report it as an unreadable source document. */
export class GitProtocolError extends Error {}

const pkt = (line: string) => {
  const bytes = encoder.encode(line);
  return [...encoder.encode((bytes.byteLength + 4).toString(16).padStart(4, "0")), ...bytes];
};
const flush = [...encoder.encode("0000")];
const delimiter = [...encoder.encode("0001")];

/** Split a pkt-line stream. Flush, delimiter and response-end packets separate sections. */
const packets = (bytes: Uint8Array) => {
  const lines: Array<Uint8Array | "boundary"> = [];
  for (let at = 0; at < bytes.byteLength;) {
    if (at + 4 > bytes.byteLength) throw new GitProtocolError("truncated packet");
    const size = Number.parseInt(decoder.decode(bytes.subarray(at, at + 4)), 16);
    if (!Number.isInteger(size) || size === 3 || at + Math.max(size, 4) > bytes.byteLength)
      throw new GitProtocolError("invalid packet length");
    if (size < 4) {
      lines.push("boundary");
      at += 4;
      continue;
    }
    lines.push(bytes.subarray(at + 4, at + size));
    at += size;
  }
  return lines;
};

export const gitRequestHeaders = {
  "Content-Type": "application/x-git-upload-pack-request",
  "Git-Protocol": "version=2",
} as const;

/** Candidate ref names for a branch, tag or HEAD, in lookup order. */
export const refCandidates = (ref: string | undefined) =>
  ref === undefined || ref === "HEAD" ? ["HEAD"] : [`refs/heads/${ref}`, `refs/tags/${ref}`];

/** Ask only for the named refs, peeling annotated tags to their commits. */
export const lsRefsRequest = (names: readonly string[]) =>
  new Uint8Array([
    ...pkt("command=ls-refs\n"),
    ...delimiter,
    ...pkt("peel\n"),
    ...names.flatMap((name) => pkt(`ref-prefix ${name}\n`)),
    ...flush,
  ]);

/** Map each advertised ref to its commit, using the peeled commit for annotated tags. */
export const parseLsRefs = (bytes: Uint8Array) => {
  const refs = new Map<string, string>();
  for (const line of packets(bytes)) {
    if (line === "boundary") continue;
    const match = /^([a-f0-9]{40}) (\S+)(?: .*?peeled:([a-f0-9]{40}))?/.exec(decoder.decode(line));
    if (match !== null) refs.set(match[2]!, match[3] ?? match[1]!);
  }
  return refs;
};

/** Fetch one commit and its trees without file contents or history. */
export const treeFetchRequest = (commit: string) =>
  new Uint8Array([
    ...pkt("command=fetch\n"),
    ...delimiter,
    ...pkt("no-progress\n"),
    ...pkt("ofs-delta\n"),
    ...pkt("deepen 1\n"),
    ...pkt("filter blob:none\n"),
    ...pkt(`want ${commit}\n`),
    ...pkt("done\n"),
    ...flush,
  ]);

/** Join the side-band data of the response's packfile section. */
const packfile = (bytes: Uint8Array) => {
  const chunks: Uint8Array[] = [];
  let inPack = false;
  for (const line of packets(bytes)) {
    if (line === "boundary") continue;
    if (!inPack) {
      inPack = decoder.decode(line) === "packfile\n";
      continue;
    }
    if (line[0] === 1) chunks.push(line.subarray(1));
    else if (line[0] === 3) throw new GitProtocolError("remote error");
  }
  if (!inPack) throw new GitProtocolError("missing packfile");
  const pack = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    pack.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return pack;
};

type ObjectType = "commit" | "tree" | "blob" | "tag";
const objectTypes: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

/** Rebuild an object from its base and a git delta. */
const applyDelta = (base: Uint8Array, delta: Uint8Array) => {
  let at = 0;
  const size = () => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      if (at >= delta.byteLength) throw new GitProtocolError("truncated delta");
      byte = delta[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  if (size() !== base.byteLength) throw new GitProtocolError("delta base size mismatch");
  const result = new Uint8Array(size());
  let length = 0;
  while (at < delta.byteLength) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let offset = 0;
      let count = 0;
      for (let bit = 0; bit < 4; bit++)
        if (op & (1 << bit)) offset += delta[at++]! * 2 ** (8 * bit);
      for (let bit = 0; bit < 3; bit++)
        if (op & (1 << (4 + bit))) count += delta[at++]! * 2 ** (8 * bit);
      if (count === 0) count = 0x10000;
      if (offset + count > base.byteLength || length + count > result.byteLength)
        throw new GitProtocolError("invalid delta copy");
      result.set(base.subarray(offset, offset + count), length);
      length += count;
    } else if (op !== 0) {
      if (at + op > delta.byteLength || length + op > result.byteLength)
        throw new GitProtocolError("invalid delta insert");
      result.set(delta.subarray(at, at + op), length);
      length += op;
      at += op;
    } else {
      throw new GitProtocolError("reserved delta opcode");
    }
  }
  if (length !== result.byteLength) throw new GitProtocolError("delta size mismatch");
  return result;
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const objectId = async (type: ObjectType, data: Uint8Array) => {
  const header = encoder.encode(`${type} ${data.byteLength}\0`);
  const whole = new Uint8Array(header.byteLength + data.byteLength);
  whole.set(header);
  whole.set(data, header.byteLength);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", whole)));
};

/** Decode every object in a packfile, resolving deltas, keyed by object id. */
const unpack = async (pack: Uint8Array, limits: { readonly objectBytes: number }) => {
  if (decoder.decode(pack.subarray(0, 4)) !== "PACK" || pack.byteLength < 32)
    throw new GitProtocolError("invalid packfile");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new GitProtocolError("unsupported packfile version");
  const count = view.getUint32(8);
  type Entry =
    | { readonly kind: "whole"; readonly type: ObjectType; readonly data: Uint8Array }
    | { readonly kind: "offset"; readonly base: number; readonly delta: Uint8Array }
    | { readonly kind: "reference"; readonly base: string; readonly delta: Uint8Array };
  const entries = new Map<number, Entry>();
  let at = 12;
  for (let index = 0; index < count; index++) {
    const start = at;
    let byte = pack[at++]!;
    const code = (byte >> 4) & 7;
    while (byte & 0x80) byte = pack[at++]!;
    if (code === 6) {
      byte = pack[at++]!;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[at++]!;
        back = (back + 1) * 128 + (byte & 0x7f);
      }
      const { data, end } = inflateZlib(pack, at, limits.objectBytes);
      entries.set(start, { kind: "offset", base: start - back, delta: data });
      at = end;
    } else if (code === 7) {
      const base = hex(pack.subarray(at, at + 20));
      const { data, end } = inflateZlib(pack, at + 20, limits.objectBytes);
      entries.set(start, { kind: "reference", base, delta: data });
      at = end;
    } else {
      const type = objectTypes[code];
      if (type === undefined) throw new GitProtocolError("invalid object type");
      const { data, end } = inflateZlib(pack, at, limits.objectBytes);
      entries.set(start, { kind: "whole", type, data });
      at = end;
    }
    if (at > pack.byteLength) throw new GitProtocolError("truncated packfile");
  }

  const objects = new Map<string, { readonly type: ObjectType; readonly data: Uint8Array }>();
  const resolved = new Map<number, { readonly type: ObjectType; readonly data: Uint8Array }>();
  const pending = new Set(entries.keys());
  // Resolve in passes so reference deltas can wait for bases that appear later in the pack.
  while (pending.size > 0) {
    let progressed = false;
    for (const offset of pending) {
      const entry = entries.get(offset)!;
      let object: { readonly type: ObjectType; readonly data: Uint8Array } | undefined;
      if (entry.kind === "whole") object = entry;
      else {
        const base = entry.kind === "offset" ? resolved.get(entry.base) : objects.get(entry.base);
        if (base !== undefined)
          object = { type: base.type, data: applyDelta(base.data, entry.delta) };
      }
      if (object === undefined) continue;
      resolved.set(offset, object);
      objects.set(await objectId(object.type, object.data), object);
      pending.delete(offset);
      progressed = true;
    }
    if (!progressed) throw new GitProtocolError("unresolved delta base");
  }
  return objects;
};

export interface GitTreeEntry {
  /** Repository-relative path. */
  readonly path: string;
  /** Git file mode, such as 100644, 100755 or 120000 for a symbolic link. */
  readonly mode: string;
}

/** List the files at a commit, limited to one directory when `path` is set. */
export const parseTreeFetch = async (
  bytes: Uint8Array,
  commit: string,
  path: string | undefined,
  limits: { readonly objectBytes: number },
) => {
  const objects = await unpack(packfile(bytes), limits);
  const head = objects.get(commit);
  if (head?.type !== "commit") throw new GitProtocolError("missing commit");
  const root = /^tree ([a-f0-9]{40})$/m.exec(decoder.decode(head.data))?.[1];
  if (root === undefined) throw new GitProtocolError("commit without tree");

  const entries = (tree: string) => {
    const object = objects.get(tree);
    if (object?.type !== "tree") throw new GitProtocolError("missing tree");
    const result: Array<{ mode: string; name: string; id: string }> = [];
    for (let at = 0; at < object.data.byteLength;) {
      const space = object.data.indexOf(0x20, at);
      const nul = object.data.indexOf(0, space);
      if (space < 0 || nul < 0 || nul + 21 > object.data.byteLength)
        throw new GitProtocolError("invalid tree entry");
      result.push({
        mode: decoder.decode(object.data.subarray(at, space)).padStart(6, "0"),
        name: decoder.decode(object.data.subarray(space + 1, nul)),
        id: hex(object.data.subarray(nul + 1, nul + 21)),
      });
      at = nul + 21;
    }
    return result;
  };

  // Walk down to the requested directory; a missing directory lists no files.
  let start = root;
  const prefix = path === undefined ? [] : path.split("/");
  for (const name of prefix) {
    const next = entries(start).find((entry) => entry.name === name && entry.mode === "040000");
    if (next === undefined) return [];
    start = next.id;
  }

  const files: GitTreeEntry[] = [];
  const walk = (tree: string, directory: string) => {
    for (const entry of entries(tree)) {
      const entryPath = `${directory}${entry.name}`;
      if (entry.mode === "040000") walk(entry.id, `${entryPath}/`);
      // Submodules (160000) point at other repositories and have no files here.
      else if (entry.mode !== "160000") {
        files.push({ path: entryPath, mode: entry.mode });
      }
    }
  };
  walk(start, prefix.length === 0 ? "" : `${prefix.join("/")}/`);
  return files;
};
