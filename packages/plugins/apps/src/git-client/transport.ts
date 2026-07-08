/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: smart-HTTP transport errors are caught by git-source and converted to AppSourceError */
// Smart-HTTP transport over fetch. Runtime-agnostic (Bun + workerd).
import { parseInfoRefs, type RefAdvertisement } from "./pktline";
import { redactUrl, validateGitFetchUrl, type GitUrlPolicy } from "./url-security";

export interface AuthRecipe {
  // Authorization header value, or undefined for anonymous.
  authorization?: string;
}

// Host-specific Basic auth recipes (verified against live hosts in this spike).
// github.com:   Basic base64("x-access-token:" + TOKEN)
// gitlab.com:   Basic base64("oauth2:" + TOKEN)
// bitbucket.org: Basic base64("x-token-auth:" + TOKEN)  (app password: user:app_password)
// generic Gitea: Basic base64(username + ":" + TOKEN)
export function basicAuth(user: string, token: string): string {
  return "Basic " + btoa(`${user}:${token}`);
}

export function authForHost(host: string, token?: string): AuthRecipe {
  if (!token) return {};
  if (host.includes("github.com")) return { authorization: basicAuth("x-access-token", token) };
  if (host.includes("gitlab.com")) return { authorization: basicAuth("oauth2", token) };
  if (host.includes("bitbucket.org")) return { authorization: basicAuth("x-token-auth", token) };
  // generic (Gitea/self-hosted): token as password with arbitrary username
  return { authorization: basicAuth("git", token) };
}

function baseHeaders(auth: AuthRecipe): Record<string, string> {
  const h: Record<string, string> = {
    "user-agent": "git/2.x",
  };
  if (auth.authorization) h.authorization = auth.authorization;
  return h;
}

function normalizeRepoUrl(url: string): string {
  let u = url.trim();
  if (u.endsWith("/")) u = u.slice(0, -1);
  if (!u.endsWith(".git")) u = u + ".git";
  return u;
}

export interface RefsResult {
  adv: RefAdvertisement;
  status: number;
  wallMs: number;
  bytes: number;
}

const MAX_REDIRECTS = 5;

const fetchGit = async (
  rawUrl: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  policy: GitUrlPolicy,
): Promise<Response> => {
  let current = validateGitFetchUrl(rawUrl, policy);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(current.toString(), {
      ...init,
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location)
      throw new Error(`git redirect missing Location from ${redactUrl(current.toString())}`);
    current = validateGitFetchUrl(new URL(location, current).toString(), policy);
  }
  throw new Error(`git redirect depth exceeded for ${redactUrl(rawUrl)}`);
};

// The cheap "did it change" check: GET info/refs. Returns the ref advertisement.
export async function checkRefs(
  url: string,
  auth: AuthRecipe = {},
  fetchImpl: typeof fetch = fetch,
  policy: GitUrlPolicy = {},
): Promise<RefsResult> {
  const repo = normalizeRepoUrl(url);
  const infoUrl = `${repo}/info/refs?service=git-upload-pack`;
  const t0 = Date.now();
  const res = await fetchGit(
    infoUrl,
    {
      headers: {
        ...baseHeaders(auth),
        accept: "*/*",
      },
    },
    fetchImpl,
    policy,
  );
  const buf = new Uint8Array(await res.arrayBuffer());
  const wallMs = Date.now() - t0;
  if (!res.ok) {
    throw new Error(`info/refs ${res.status}: ${new TextDecoder().decode(buf.subarray(0, 200))}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("git-upload-pack-advertisement")) {
    // Some hosts (or a wrong URL) return HTML; treat as protocol failure.
    throw new Error(`unexpected content-type: ${ct}`);
  }
  const adv = parseInfoRefs(buf);
  return { adv, status: res.status, wallMs, bytes: buf.length };
}

export interface UploadPackOptions {
  auth?: AuthRecipe;
  fetchImpl?: typeof fetch;
  // Abort the response body after this many bytes (byte cap).
  maxBytes?: number;
  useV2?: boolean;
  allowPrivateHosts?: boolean;
}

export interface UploadPackResult {
  packBytes: Uint8Array;
  status: number;
  wallMs: number;
  truncated: boolean;
  capUsed: number;
}

// Build a protocol-v1 upload-pack request body: want <sha> with caps, deepen 1, done.
import { FLUSH, pktLine } from "./pktline";

function buildV1Request(sha: string): Uint8Array {
  const caps = "multi_ack side-band-64k thin-pack ofs-delta";
  const parts: Uint8Array[] = [];
  parts.push(pktLine(`want ${sha} ${caps}\n`));
  parts.push(pktLine(`deepen 1\n`));
  parts.push(FLUSH);
  parts.push(pktLine(`done\n`));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// POST /git-upload-pack, parse side-band, extract raw packfile bytes.
// Handles side-band-64k: band 1 = pack data, band 2 = progress, band 3 = error.
export async function uploadPack(
  url: string,
  sha: string,
  opts: UploadPackOptions = {},
): Promise<UploadPackResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const repo = normalizeRepoUrl(url);
  const upUrl = `${repo}/git-upload-pack`;
  const body = buildV1Request(sha);
  const t0 = Date.now();
  const res = await fetchGit(
    upUrl,
    {
      method: "POST",
      headers: {
        ...baseHeaders(opts.auth ?? {}),
        "content-type": "application/x-git-upload-pack-request",
        accept: "application/x-git-upload-pack-result",
        "git-protocol": "version=1",
      },
      body: new Uint8Array(body).buffer,
    },
    fetchImpl,
    { allowPrivateHosts: opts.allowPrivateHosts },
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`upload-pack ${res.status}: ${errText.slice(0, 200)}`);
  }

  // Stream + demux side-band pkt-lines, with a byte cap on total downloaded.
  const reader = res.body!.getReader();
  const maxBytes = opts.maxBytes ?? Infinity;
  let downloaded = 0;
  let truncated = false;

  // Accumulate raw bytes, then demux pkt-lines. We buffer because pkt-lines can
  // straddle chunk boundaries; we cap the RAW download.
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      downloaded += value.length;
      chunks.push(value);
      if (downloaded >= maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  }
  const wallMs = Date.now() - t0;

  // concat
  const raw = new Uint8Array(downloaded);
  {
    let off = 0;
    for (const c of chunks) {
      raw.set(c.subarray(0, Math.min(c.length, raw.length - off)), off);
      off += c.length;
      if (off >= raw.length) break;
    }
  }

  // Demux side-band pkt-lines into packfile bytes.
  const pack = demuxSideBand(raw);
  return { packBytes: pack, status: res.status, wallMs, truncated, capUsed: downloaded };
}

const tdLocal = new TextDecoder();

function demuxSideBand(raw: Uint8Array): Uint8Array {
  const packChunks: Uint8Array[] = [];
  let off = 0;

  // Phase 1: consume the shallow/ACK/NAK preamble. These pkt-lines are NOT
  // side-band framed. The preamble ends at the first flush pkt (0000) that
  // separates negotiation from the packfile stream. GitHub sends:
  //   shallow <sha>\n  0000  NAK\n  <side-band lines...>
  // GitLab/others may send just NAK\n before side-band with no flush; so we
  // also stop the preamble as soon as a line's first byte is a valid band id
  // (1/2/3) AND the remainder doesn't look like a git control word.
  const isControlLine = (payload: Uint8Array): boolean => {
    const s = tdLocal.decode(payload.subarray(0, Math.min(payload.length, 8)));
    return (
      s.startsWith("shallow ") ||
      s.startsWith("unshallow") ||
      s.startsWith("ACK") ||
      s.startsWith("NAK") ||
      s.startsWith("ERR ")
    );
  };

  while (off + 4 <= raw.length) {
    const len = parseInt(tdLocal.decode(raw.subarray(off, off + 4)), 16);
    if (Number.isNaN(len)) throw new Error("bad pkt-line length in upload-pack response");
    if (len === 0) {
      off += 4;
      // A flush during preamble ends the negotiation section; keep going into side-band.
      continue;
    }
    if (len === 1) {
      off += 4;
      continue;
    }
    if (len < 4) throw new Error("bad pkt-line length in upload-pack response");
    if (off + len > raw.length) throw new Error("truncated upload-pack response");
    const payload = raw.subarray(off + 4, off + len);
    if (payload.length === 0) {
      off += len;
      continue;
    }
    if (isControlLine(payload)) {
      off += len; // skip negotiation line
      continue;
    }
    // side-band framed from here on
    const band = payload[0];
    const data = payload.subarray(1);
    off += len;
    if (band === 1) {
      packChunks.push(data);
    } else if (band === 2) {
      // progress; ignore
    } else if (band === 3) {
      throw new Error("remote error: " + tdLocal.decode(data));
    } else {
      // Not side-band framed at all (side-band not negotiated): whole payload is pack.
      packChunks.push(payload);
    }
  }
  if (off !== raw.length) throw new Error("truncated upload-pack response");
  let total = 0;
  for (const c of packChunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of packChunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
