/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: pure packfile parser throws are caught by git-source and converted to AppSourceError */
// Packfile parser: header, object headers, zlib inflate, delta resolution, then
// commit-to-tree-to-blob walking. Pure Web APIs.

const te = new TextEncoder();
const td = new TextDecoder();

// git object type ids in packfiles
const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

export interface GitObject {
  type: number; // resolved base type (1..4)
  data: Uint8Array;
}

// sha1 over "type len\0data" to compute object id, needed to key REF_DELTA bases.
// Minimal sha1 (needed because Workers crypto.subtle is async; git object ids are sha1).
// We use crypto.subtle.digest("SHA-1") which IS available on workerd.
async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", bytes as BufferSource);
  const arr = new Uint8Array(buf);
  let s = "";
  for (const b of arr) s += b.toString(16).padStart(2, "0");
  return s;
}

function gitObjectId(type: number, data: Uint8Array): Promise<string> {
  const typeName =
    type === OBJ_COMMIT
      ? "commit"
      : type === OBJ_TREE
        ? "tree"
        : type === OBJ_BLOB
          ? "blob"
          : "tag";
  const header = te.encode(`${typeName} ${data.length}\0`);
  const full = new Uint8Array(header.length + data.length);
  full.set(header, 0);
  full.set(data, header.length);
  return sha1Hex(full);
}

// Inflate a zlib stream starting at offset and report consumed input bytes.
// The pack parser needs the consumed length to advance to the next object.

// --- Minimal INFLATE (RFC1951) + zlib wrapper, tracking bytes consumed ---
// Compact implementation; handles stored/fixed/dynamic Huffman.
class BitReader {
  buf: Uint8Array;
  pos: number;
  bitBuf = 0;
  bitCnt = 0;
  constructor(buf: Uint8Array, pos: number) {
    this.buf = buf;
    this.pos = pos;
  }
  bit(): number {
    if (this.bitCnt === 0) {
      this.bitBuf = this.buf[this.pos++];
      this.bitCnt = 8;
    }
    const b = this.bitBuf & 1;
    this.bitBuf >>= 1;
    this.bitCnt--;
    return b;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.bit() << i;
    return v;
  }
  align() {
    this.bitCnt = 0;
  }
}

interface Huff {
  counts: number[];
  symbols: number[];
}
function buildHuff(lengths: number[], n: number): Huff {
  const counts = new Array(16).fill(0);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offsets = new Array(16).fill(0);
  for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
  const symbols = new Array(n).fill(0);
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
  return { counts, symbols };
}
function decodeSym(br: BitReader, h: Huff): number {
  let code = 0,
    first = 0,
    index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= br.bit();
    const count = h.counts[len];
    if (code - first < count) return h.symbols[index + (code - first)];
    index += count;
    first += count;
    first <<= 1;
    code <<= 1;
  }
  throw new Error("bad huffman code");
}
const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Inflate raw DEFLATE at buf[pos..], return {out, endPos}
function inflateRaw(buf: Uint8Array, pos: number): { out: Uint8Array; endPos: number } {
  const br = new BitReader(buf, pos);
  const out: number[] = [];
  let final = 0;
  do {
    final = br.bit();
    const type = br.bits(2);
    if (type === 0) {
      br.align();
      const len = buf[br.pos] | (buf[br.pos + 1] << 8);
      br.pos += 4; // len + nlen
      for (let i = 0; i < len; i++) out.push(buf[br.pos++]);
    } else {
      let litH: Huff, distH: Huff;
      if (type === 1) {
        const ll = new Array(288);
        for (let i = 0; i < 144; i++) ll[i] = 8;
        for (let i = 144; i < 256; i++) ll[i] = 9;
        for (let i = 256; i < 280; i++) ll[i] = 7;
        for (let i = 280; i < 288; i++) ll[i] = 8;
        litH = buildHuff(ll, 288);
        distH = buildHuff(new Array(30).fill(5), 30);
      } else {
        const hlit = br.bits(5) + 257;
        const hdist = br.bits(5) + 1;
        const hclen = br.bits(4) + 4;
        const clen = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = br.bits(3);
        const clH = buildHuff(clen, 19);
        const lengths: number[] = [];
        while (lengths.length < hlit + hdist) {
          const sym = decodeSym(br, clH);
          if (sym < 16) lengths.push(sym);
          else if (sym === 16) {
            const r = br.bits(2) + 3;
            const prev = lengths[lengths.length - 1];
            for (let i = 0; i < r; i++) lengths.push(prev);
          } else if (sym === 17) {
            const r = br.bits(3) + 3;
            for (let i = 0; i < r; i++) lengths.push(0);
          } else {
            const r = br.bits(7) + 11;
            for (let i = 0; i < r; i++) lengths.push(0);
          }
        }
        litH = buildHuff(lengths.slice(0, hlit), hlit);
        distH = buildHuff(lengths.slice(hlit), hdist);
      }
      while (true) {
        const sym = decodeSym(br, litH);
        if (sym === 256) break;
        if (sym < 256) out.push(sym);
        else {
          const l = LEN_BASE[sym - 257] + br.bits(LEN_EXTRA[sym - 257]);
          const dsym = decodeSym(br, distH);
          const dist = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
          const start = out.length - dist;
          for (let i = 0; i < l; i++) out.push(out[start + i]);
        }
      }
    }
  } while (!final);
  br.align();
  return { out: Uint8Array.from(out), endPos: br.pos };
}

// zlib wrapper: 2-byte header, deflate, 4-byte adler32. Return inflated + end offset.
function inflateZlib(buf: Uint8Array, pos: number): { out: Uint8Array; endPos: number } {
  // skip 2-byte zlib header
  const r = inflateRaw(buf, pos + 2);
  return { out: r.out, endPos: r.endPos + 4 }; // + adler32
}

// --- Packfile top-level parse ---
interface RawObj {
  type: number;
  data?: Uint8Array; // for non-delta
  // delta:
  baseOfs?: number; // absolute offset of base (OFS_DELTA)
  baseRef?: string; // sha of base (REF_DELTA)
  delta?: Uint8Array;
  offset: number;
}

function readVarintSize(buf: Uint8Array, pos: number): { type: number; size: number; pos: number } {
  let c = buf[pos++];
  const type = (c >> 4) & 7;
  let size = c & 15;
  let shift = 4;
  while (c & 0x80) {
    c = buf[pos++];
    size |= (c & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, pos };
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let p = 0;
  // base size (varint)
  let c = delta[p++];
  let baseSize = c & 0x7f;
  let shift = 7;
  while (c & 0x80) {
    c = delta[p++];
    baseSize |= (c & 0x7f) << shift;
    shift += 7;
  }
  // result size (varint)
  c = delta[p++];
  let resSize = c & 0x7f;
  shift = 7;
  while (c & 0x80) {
    c = delta[p++];
    resSize |= (c & 0x7f) << shift;
    shift += 7;
  }
  const out = new Uint8Array(resSize);
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      // copy from base
      let cpOff = 0,
        cpLen = 0;
      if (op & 0x01) cpOff = delta[p++];
      if (op & 0x02) cpOff |= delta[p++] << 8;
      if (op & 0x04) cpOff |= delta[p++] << 16;
      if (op & 0x08) cpOff |= delta[p++] << 24;
      if (op & 0x10) cpLen = delta[p++];
      if (op & 0x20) cpLen |= delta[p++] << 8;
      if (op & 0x40) cpLen |= delta[p++] << 16;
      if (cpLen === 0) cpLen = 0x10000;
      out.set(base.subarray(cpOff, cpOff + cpLen), o);
      o += cpLen;
    } else if (op) {
      // insert `op` literal bytes
      out.set(delta.subarray(p, p + op), o);
      o += op;
      p += op;
    } else {
      throw new Error("bad delta opcode 0");
    }
  }
  return out;
}

export interface ParsedPack {
  objects: Map<string, GitObject>; // sha -> resolved object
  byOffset: Map<number, GitObject>;
  count: number;
}

// Parse a full packfile and resolve all deltas. Returns objects keyed by sha.
export async function parsePack(pack: Uint8Array): Promise<ParsedPack> {
  if (td.decode(pack.subarray(0, 4)) !== "PACK") throw new Error("not a packfile");
  const version = new DataView(pack.buffer, pack.byteOffset + 4, 4).getUint32(0);
  const count = new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0);
  let pos = 12;

  const raws: RawObj[] = [];
  for (let i = 0; i < count; i++) {
    const start = pos;
    const { type, pos: p1 } = readVarintSize(pack, pos);
    pos = p1;
    if (type === OBJ_OFS_DELTA) {
      // negative offset varint
      let c = pack[pos++];
      let ofs = c & 0x7f;
      while (c & 0x80) {
        c = pack[pos++];
        ofs = ((ofs + 1) << 7) | (c & 0x7f);
      }
      const baseOfs = start - ofs;
      const inf = inflateZlib(pack, pos);
      pos = inf.endPos;
      raws.push({ type, baseOfs, delta: inf.out, offset: start });
    } else if (type === OBJ_REF_DELTA) {
      let hex = "";
      for (let j = 0; j < 20; j++) hex += pack[pos + j].toString(16).padStart(2, "0");
      pos += 20;
      const inf = inflateZlib(pack, pos);
      pos = inf.endPos;
      raws.push({ type, baseRef: hex, delta: inf.out, offset: start });
    } else {
      const inf = inflateZlib(pack, pos);
      pos = inf.endPos;
      raws.push({ type, data: inf.out, offset: start });
    }
  }

  // Resolve: first pass non-deltas, then iteratively resolve deltas.
  const byOffset = new Map<number, GitObject>();
  const byRef = new Map<string, GitObject>();
  const objects = new Map<string, GitObject>();

  // index base bytes by offset (for OFS) and we need sha for REF resolution.
  const pending = [...raws];
  // resolve non-delta first
  for (const r of pending) {
    if (r.data && r.type <= OBJ_TAG) {
      const obj: GitObject = { type: r.type, data: r.data };
      byOffset.set(r.offset, obj);
      const sha = await gitObjectId(r.type, r.data);
      byRef.set(sha, obj);
      objects.set(sha, obj);
    }
  }
  // resolve deltas iteratively
  let remaining = pending.filter((r) => r.delta);
  let progress = true;
  while (remaining.length && progress) {
    progress = false;
    const still: RawObj[] = [];
    for (const r of remaining) {
      let base: GitObject | undefined;
      if (r.baseOfs !== undefined) base = byOffset.get(r.baseOfs);
      else if (r.baseRef) base = byRef.get(r.baseRef);
      if (!base) {
        still.push(r);
        continue;
      }
      const resolved = applyDelta(base.data, r.delta!);
      const obj: GitObject = { type: base.type, data: resolved };
      byOffset.set(r.offset, obj);
      const sha = await gitObjectId(base.type, resolved);
      byRef.set(sha, obj);
      objects.set(sha, obj);
      progress = true;
    }
    remaining = still;
  }
  if (remaining.length) throw new Error(`unresolved deltas: ${remaining.length}`);

  return { objects, byOffset, count, version } as ParsedPack;
}

// --- Tree walking: commit sha -> file list ---
export interface TreeFile {
  path: string;
  mode: string;
  sha: string;
  bytes: Uint8Array;
}

function parseCommit(data: Uint8Array): { tree: string } {
  const text = td.decode(data);
  const m = text.match(/^tree ([0-9a-f]{40})/m);
  if (!m) throw new Error("commit has no tree");
  return { tree: m[1] };
}

// Parse a tree object: entries of "mode<space>name\0<20-byte sha>"
function parseTree(data: Uint8Array): { mode: string; name: string; sha: string }[] {
  const entries: { mode: string; name: string; sha: string }[] = [];
  let p = 0;
  while (p < data.length) {
    let sp = p;
    while (data[sp] !== 0x20) sp++;
    const mode = td.decode(data.subarray(p, sp));
    let nul = sp + 1;
    while (data[nul] !== 0) nul++;
    const name = td.decode(data.subarray(sp + 1, nul));
    let sha = "";
    for (let i = 0; i < 20; i++) sha += data[nul + 1 + i].toString(16).padStart(2, "0");
    p = nul + 21;
    entries.push({ mode, name, sha });
  }
  return entries;
}

// Walk from commit sha to a flat file list. Blobs must be present in pack.
export function walkTree(parsed: ParsedPack, commitSha: string): TreeFile[] {
  const commit = parsed.objects.get(commitSha);
  if (!commit) throw new Error(`commit ${commitSha} not in pack`);
  const { tree } = parseCommit(commit.data);
  const files: TreeFile[] = [];
  const recur = (treeSha: string, prefix: string) => {
    const t = parsed.objects.get(treeSha);
    if (!t) throw new Error(`tree ${treeSha} not in pack`);
    for (const e of parseTree(t.data)) {
      const full = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === "40000" || e.mode === "040000") {
        recur(e.sha, full);
      } else if (e.mode === "160000") {
        // gitlink/submodule; skip
      } else {
        const blob = parsed.objects.get(e.sha);
        if (!blob) throw new Error(`blob ${e.sha} (${full}) not in pack`);
        files.push({ path: full, mode: e.mode, sha: e.sha, bytes: blob.data });
      }
    }
  };
  recur(tree, "");
  return files;
}

export { inflateZlib, inflateRaw };
