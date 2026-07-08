/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: pure git protocol parser throws are caught by git-source and converted to AppSourceError */
// Shared pkt-line parsing + refs advertisement parse.
// Works in both Bun and workerd (no Node-isms; only Web APIs + Uint8Array).

const td = new TextDecoder();
const te = new TextEncoder();

export function pktLine(payload: string | Uint8Array): Uint8Array {
  const body = typeof payload === "string" ? te.encode(payload) : payload;
  const len = body.length + 4;
  const hdr = te.encode(len.toString(16).padStart(4, "0"));
  const out = new Uint8Array(hdr.length + body.length);
  out.set(hdr, 0);
  out.set(body, hdr.length);
  return out;
}

export const FLUSH = te.encode("0000");
export const DELIM = te.encode("0001");

// Streaming pkt-line reader over a Uint8Array buffer.
export interface PktToken {
  kind: "line" | "flush" | "delim";
  data?: Uint8Array;
}

export function parsePktLines(
  buf: Uint8Array,
  options: { readonly requireComplete?: boolean } = {},
): { tokens: PktToken[]; consumed: number } {
  const tokens: PktToken[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = td.decode(buf.subarray(off, off + 4));
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length: ${lenHex}`);
    if (len === 0) {
      tokens.push({ kind: "flush" });
      off += 4;
      continue;
    }
    if (len === 1) {
      tokens.push({ kind: "delim" });
      off += 4;
      continue;
    }
    if (len < 4) throw new Error(`bad pkt-line length: ${lenHex}`);
    if (off + len > buf.length) break; // incomplete; caller supplies more
    const data = buf.subarray(off + 4, off + len);
    tokens.push({ kind: "line", data });
    off += len;
  }
  if (options.requireComplete === true && off !== buf.length) {
    throw new Error("truncated pkt-line response");
  }
  return { tokens, consumed: off };
}

// --- Refs advertisement (protocol v1 dumb-ish smart-http info/refs) ---

export interface RefAdvertisement {
  refs: Map<string, string>; // refname -> sha
  headTarget?: string; // symref HEAD target (e.g. refs/heads/main)
  capabilities: string[];
  protocolVersion: number;
}

// Parse the response of GET /info/refs?service=git-upload-pack (protocol v1).
export function parseInfoRefs(bytes: Uint8Array): RefAdvertisement {
  const { tokens } = parsePktLines(bytes, { requireComplete: true });
  const refs = new Map<string, string>();
  let capabilities: string[] = [];
  let headTarget: string | undefined;
  let sawService = false;
  let first = true;

  for (const t of tokens) {
    if (t.kind !== "line" || !t.data) continue;
    let line = td.decode(t.data);
    if (line.endsWith("\n")) line = line.slice(0, -1);
    if (line.startsWith("# service=")) {
      sawService = true;
      continue;
    }
    // first ref line carries \0-separated capabilities
    if (first) {
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        capabilities = line
          .slice(nul + 1)
          .split(" ")
          .filter(Boolean);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const sha = line.slice(0, sp);
    const name = line.slice(sp + 1);
    if (/^[0-9a-f]{40,64}$/.test(sha)) refs.set(name, sha);
  }

  // symref HEAD from capabilities: symref=HEAD:refs/heads/main
  for (const cap of capabilities) {
    if (cap.startsWith("symref=HEAD:")) headTarget = cap.slice("symref=HEAD:".length);
  }

  return { refs, headTarget, capabilities, protocolVersion: sawService ? 1 : 1 };
}

// Resolve which sha a caller wants given a ref advertisement + optional ref name.
export function resolveWant(
  adv: RefAdvertisement,
  ref?: string,
): { sha: string; resolvedRef: string } {
  if (ref) {
    // try exact, then heads/, then tags/
    const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/${ref}`];
    for (const c of candidates) {
      const sha = adv.refs.get(c);
      if (sha) return { sha, resolvedRef: c };
    }
    // maybe they passed a sha directly
    if (/^[0-9a-f]{40,64}$/.test(ref)) return { sha: ref, resolvedRef: ref };
    throw new Error(`ref not found: ${ref}`);
  }
  // default: HEAD symref target, else HEAD ref, else first
  if (adv.headTarget) {
    const sha = adv.refs.get(adv.headTarget);
    if (sha) return { sha, resolvedRef: adv.headTarget };
  }
  const head = adv.refs.get("HEAD");
  if (head) return { sha: head, resolvedRef: "HEAD" };
  const first = adv.refs.entries().next();
  if (!first.done) return { sha: first.value[1], resolvedRef: first.value[0] };
  throw new Error("no refs advertised");
}

export { td, te };
