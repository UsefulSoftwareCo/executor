/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: pure packfile parser throws are caught by git-source and converted to AppSourceError */
import { PUBLISH_LIMITS } from "../pipeline/publish";

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

export interface ParsePackLimits {
  readonly maxObjectBytes: number;
  readonly maxDeltaResultBytes: number;
  readonly maxExpandedBytes: number;
}

export interface ParsePackOptions {
  readonly limits?: Partial<ParsePackLimits>;
}

const DEFAULT_LIMITS: ParsePackLimits = {
  maxObjectBytes: PUBLISH_LIMITS.maxFileBytes,
  maxDeltaResultBytes: PUBLISH_LIMITS.maxFileBytes,
  maxExpandedBytes: PUBLISH_LIMITS.maxTotalBytes,
};

const limitsFor = (options?: ParsePackOptions): ParsePackLimits => ({
  ...DEFAULT_LIMITS,
  ...(options?.limits ?? {}),
});

const repositoryTooLarge = (message: string): Error =>
  new Error(`repository too large: ${message}`);

class PackParseError extends Error {
  constructor(message: string) {
    super(`pack parse error: ${message}`);
  }
}

const requireAvailable = (buf: Uint8Array, pos: number, length: number, what: string): void => {
  if (pos < 0 || length < 0 || pos + length > buf.length) {
    throw new PackParseError(`truncated ${what}`);
  }
};

const checkedAdd = (a: number, b: number, what: string): number => {
  const value = a + b;
  if (!Number.isSafeInteger(value)) throw new PackParseError(`${what} exceeds safe integer range`);
  return value;
};

const checkedMul = (a: number, b: number, what: string): number => {
  const value = a * b;
  if (!Number.isSafeInteger(value)) throw new PackParseError(`${what} exceeds safe integer range`);
  return value;
};

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
      requireAvailable(this.buf, this.pos, 1, "deflate stream");
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
  throw new PackParseError("bad huffman code");
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
function pushInflated(out: number[], byte: number, maxObjectBytes: number): void {
  if (out.length + 1 > maxObjectBytes) {
    throw repositoryTooLarge(`inflated object exceeds ${maxObjectBytes} bytes`);
  }
  out.push(byte);
}

function inflateRaw(
  buf: Uint8Array,
  pos: number,
  limits: Pick<ParsePackLimits, "maxObjectBytes"> = DEFAULT_LIMITS,
): { out: Uint8Array; endPos: number } {
  const br = new BitReader(buf, pos);
  const out: number[] = [];
  let final = 0;
  do {
    final = br.bit();
    const type = br.bits(2);
    if (type === 0) {
      br.align();
      requireAvailable(buf, br.pos, 4, "stored deflate block header");
      const len = buf[br.pos] | (buf[br.pos + 1] << 8);
      const nlen = buf[br.pos + 2] | (buf[br.pos + 3] << 8);
      if (((len ^ 0xffff) & 0xffff) !== nlen) {
        throw new PackParseError("bad stored deflate length");
      }
      br.pos += 4; // len + nlen
      requireAvailable(buf, br.pos, len, "stored deflate block");
      for (let i = 0; i < len; i++) pushInflated(out, buf[br.pos++]!, limits.maxObjectBytes);
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
        if (sym < 256) pushInflated(out, sym, limits.maxObjectBytes);
        else {
          if (sym < 257 || sym > 285) throw new PackParseError(`bad length symbol: ${sym}`);
          const l = LEN_BASE[sym - 257] + br.bits(LEN_EXTRA[sym - 257]);
          const dsym = decodeSym(br, distH);
          if (dsym < 0 || dsym >= DIST_BASE.length) {
            throw new PackParseError(`bad distance symbol: ${dsym}`);
          }
          const dist = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
          const start = out.length - dist;
          if (start < 0) throw new PackParseError("deflate distance exceeds output size");
          for (let i = 0; i < l; i++) pushInflated(out, out[start + i]!, limits.maxObjectBytes);
        }
      }
    }
  } while (!final);
  br.align();
  return { out: Uint8Array.from(out), endPos: br.pos };
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return (b * 65536 + a) >>> 0;
}

// zlib wrapper: 2-byte header, deflate, 4-byte adler32. Return inflated + end offset.
function inflateZlib(
  buf: Uint8Array,
  pos: number,
  limits: Pick<ParsePackLimits, "maxObjectBytes"> = DEFAULT_LIMITS,
): { out: Uint8Array; endPos: number } {
  requireAvailable(buf, pos, 2, "zlib header");
  const cmf = buf[pos]!;
  const flg = buf[pos + 1]!;
  if ((cmf & 0x0f) !== 8) throw new PackParseError("unsupported zlib compression method");
  if ((cmf * 256 + flg) % 31 !== 0) throw new PackParseError("bad zlib header checksum");
  if ((flg & 0x20) !== 0) throw new PackParseError("zlib preset dictionaries are not supported");
  const r = inflateRaw(buf, pos + 2, limits);
  requireAvailable(buf, r.endPos, 4, "zlib adler32 trailer");
  const expected = new DataView(buf.buffer, buf.byteOffset + r.endPos, 4).getUint32(0);
  const actual = adler32(r.out);
  if (expected !== actual) throw new PackParseError("bad zlib adler32");
  return { out: r.out, endPos: r.endPos + 4 };
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
  requireAvailable(buf, pos, 1, "object header");
  let c = buf[pos++];
  const type = (c >> 4) & 7;
  let size = c & 15;
  let multiplier = 16;
  let bytes = 1;
  while (c & 0x80) {
    if (bytes >= 7) throw new PackParseError("object size varint is too long");
    requireAvailable(buf, pos, 1, "object size varint");
    c = buf[pos++];
    size = checkedAdd(size, checkedMul(c & 0x7f, multiplier, "object size"), "object size");
    multiplier = checkedMul(multiplier, 128, "object size multiplier");
    bytes += 1;
  }
  return { type, size, pos };
}

function readDeltaVarint(
  delta: Uint8Array,
  pos: number,
  label: string,
): { value: number; pos: number } {
  requireAvailable(delta, pos, 1, label);
  let c = delta[pos++]!;
  let value = c & 0x7f;
  let multiplier = 128;
  let bytes = 1;
  while (c & 0x80) {
    if (bytes >= 7) throw new PackParseError(`${label} varint is too long`);
    requireAvailable(delta, pos, 1, label);
    c = delta[pos++]!;
    value = checkedAdd(value, checkedMul(c & 0x7f, multiplier, label), label);
    multiplier = checkedMul(multiplier, 128, `${label} multiplier`);
    bytes += 1;
  }
  return { value, pos };
}

function applyDelta(
  base: Uint8Array,
  delta: Uint8Array,
  limits: Pick<ParsePackLimits, "maxDeltaResultBytes"> = DEFAULT_LIMITS,
): Uint8Array {
  let p = 0;
  const baseSize = readDeltaVarint(delta, p, "delta base size");
  p = baseSize.pos;
  if (baseSize.value !== base.length) {
    throw new PackParseError("delta base size does not match base object");
  }
  const resSize = readDeltaVarint(delta, p, "delta result size");
  p = resSize.pos;
  if (resSize.value > limits.maxDeltaResultBytes) {
    throw repositoryTooLarge(`delta result exceeds ${limits.maxDeltaResultBytes} bytes`);
  }
  const out = new Uint8Array(resSize.value);
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      // copy from base
      let cpOff = 0,
        cpLen = 0;
      if (op & 0x01) {
        requireAvailable(delta, p, 1, "delta copy offset");
        cpOff += delta[p++]!;
      }
      if (op & 0x02) {
        requireAvailable(delta, p, 1, "delta copy offset");
        cpOff += delta[p++]! * 256;
      }
      if (op & 0x04) {
        requireAvailable(delta, p, 1, "delta copy offset");
        cpOff += delta[p++]! * 65536;
      }
      if (op & 0x08) {
        requireAvailable(delta, p, 1, "delta copy offset");
        cpOff += delta[p++]! * 16777216;
      }
      if (op & 0x10) {
        requireAvailable(delta, p, 1, "delta copy length");
        cpLen += delta[p++]!;
      }
      if (op & 0x20) {
        requireAvailable(delta, p, 1, "delta copy length");
        cpLen += delta[p++]! * 256;
      }
      if (op & 0x40) {
        requireAvailable(delta, p, 1, "delta copy length");
        cpLen += delta[p++]! * 65536;
      }
      if (cpLen === 0) cpLen = 0x10000;
      requireAvailable(base, cpOff, cpLen, "delta copy source");
      requireAvailable(out, o, cpLen, "delta copy target");
      out.set(base.subarray(cpOff, cpOff + cpLen), o);
      o += cpLen;
    } else if (op) {
      // insert `op` literal bytes
      requireAvailable(delta, p, op, "delta insert");
      requireAvailable(out, o, op, "delta insert target");
      out.set(delta.subarray(p, p + op), o);
      o += op;
      p += op;
    } else {
      throw new PackParseError("bad delta opcode 0");
    }
  }
  if (o !== out.length) throw new PackParseError("delta result length does not match header");
  return out;
}

export interface ParsedPack {
  objects: Map<string, GitObject>; // sha -> resolved object
  byOffset: Map<number, GitObject>;
  count: number;
}

// Parse a full packfile and resolve all deltas. Returns objects keyed by sha.
export async function parsePack(pack: Uint8Array, options?: ParsePackOptions): Promise<ParsedPack> {
  const limits = limitsFor(options);
  requireAvailable(pack, 0, 12, "pack header");
  if (td.decode(pack.subarray(0, 4)) !== "PACK") throw new PackParseError("not a packfile");
  const version = new DataView(pack.buffer, pack.byteOffset + 4, 4).getUint32(0);
  if (version !== 2 && version !== 3) {
    throw new PackParseError(`unsupported pack version: ${version}`);
  }
  const count = new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0);
  let pos = 12;
  let expandedBytes = 0;

  const accountExpanded = (size: number): void => {
    expandedBytes = checkedAdd(expandedBytes, size, "expanded pack size");
    if (expandedBytes > limits.maxExpandedBytes) {
      throw repositoryTooLarge(`expanded objects exceed ${limits.maxExpandedBytes} bytes`);
    }
  };

  const raws: RawObj[] = [];
  for (let i = 0; i < count; i++) {
    const start = pos;
    const { type, size, pos: p1 } = readVarintSize(pack, pos);
    if (size > limits.maxObjectBytes && type !== OBJ_OFS_DELTA && type !== OBJ_REF_DELTA) {
      throw repositoryTooLarge(`object declares ${size} bytes`);
    }
    pos = p1;
    if (type === OBJ_OFS_DELTA) {
      // negative offset varint
      requireAvailable(pack, pos, 1, "ofs-delta base offset");
      let c = pack[pos++]!;
      let ofs = c & 0x7f;
      let bytes = 1;
      while (c & 0x80) {
        if (bytes >= 7) throw new PackParseError("ofs-delta offset varint is too long");
        requireAvailable(pack, pos, 1, "ofs-delta base offset");
        c = pack[pos++]!;
        ofs = checkedAdd(
          checkedMul(ofs + 1, 128, "ofs-delta offset"),
          c & 0x7f,
          "ofs-delta offset",
        );
        bytes += 1;
      }
      const baseOfs = start - ofs;
      if (baseOfs < 12 || baseOfs >= start) {
        throw new PackParseError("ofs-delta base offset is invalid");
      }
      const inf = inflateZlib(pack, pos, limits);
      pos = inf.endPos;
      accountExpanded(inf.out.length);
      raws.push({ type, baseOfs, delta: inf.out, offset: start });
    } else if (type === OBJ_REF_DELTA) {
      requireAvailable(pack, pos, 20, "ref-delta base sha");
      let hex = "";
      for (let j = 0; j < 20; j++) hex += pack[pos + j].toString(16).padStart(2, "0");
      pos += 20;
      const inf = inflateZlib(pack, pos, limits);
      pos = inf.endPos;
      accountExpanded(inf.out.length);
      raws.push({ type, baseRef: hex, delta: inf.out, offset: start });
    } else {
      if (type < OBJ_COMMIT || type > OBJ_TAG) {
        throw new PackParseError(`unsupported object type: ${type}`);
      }
      const inf = inflateZlib(pack, pos, limits);
      pos = inf.endPos;
      accountExpanded(inf.out.length);
      raws.push({ type, data: inf.out, offset: start });
    }
  }
  requireAvailable(pack, pos, 20, "pack trailer");

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
      const resolved = applyDelta(base.data, r.delta!, limits);
      accountExpanded(resolved.length);
      const obj: GitObject = { type: base.type, data: resolved };
      byOffset.set(r.offset, obj);
      const sha = await gitObjectId(base.type, resolved);
      byRef.set(sha, obj);
      objects.set(sha, obj);
      progress = true;
    }
    remaining = still;
  }
  if (remaining.length) throw new PackParseError(`unresolved deltas: ${remaining.length}`);

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
  if (!m) throw new PackParseError("commit has no tree");
  return { tree: m[1] };
}

// Parse a tree object: entries of "mode<space>name\0<20-byte sha>"
function parseTree(data: Uint8Array): { mode: string; name: string; sha: string }[] {
  const entries: { mode: string; name: string; sha: string }[] = [];
  let p = 0;
  while (p < data.length) {
    let sp = p;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    if (sp >= data.length) throw new PackParseError("malformed tree entry mode");
    const mode = td.decode(data.subarray(p, sp));
    let nul = sp + 1;
    while (nul < data.length && data[nul] !== 0) nul++;
    if (nul >= data.length) throw new PackParseError("malformed tree entry name");
    requireAvailable(data, nul + 1, 20, "tree entry sha");
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
  if (!commit) throw new PackParseError(`commit ${commitSha} not in pack`);
  const { tree } = parseCommit(commit.data);
  const files: TreeFile[] = [];
  const recur = (treeSha: string, prefix: string) => {
    const t = parsed.objects.get(treeSha);
    if (!t) throw new PackParseError(`tree ${treeSha} not in pack`);
    for (const e of parseTree(t.data)) {
      const full = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === "40000" || e.mode === "040000") {
        recur(e.sha, full);
      } else if (e.mode === "160000") {
        // gitlink/submodule; skip
      } else {
        const blob = parsed.objects.get(e.sha);
        if (!blob) throw new PackParseError(`blob ${e.sha} (${full}) not in pack`);
        files.push({ path: full, mode: e.mode, sha: e.sha, bytes: blob.data });
      }
    }
  };
  recur(tree, "");
  return files;
}

export { inflateZlib, inflateRaw };
