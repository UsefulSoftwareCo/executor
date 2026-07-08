/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: git client returns stable ok/error envelopes before git-source maps to AppSourceError */
// Hand-rolled shallow fetch. Orchestrates transport and packfile parsing.
import { resolveWant } from "./pktline";
import { parsePack, walkTree } from "./packfile";
import { authForHost, checkRefs, uploadPack, type AuthRecipe } from "./transport";

export interface FetchResult {
  ok: boolean;
  sha?: string;
  resolvedRef?: string;
  fileCount?: number;
  totalBytes?: number;
  packBytes?: number;
  refsMs?: number;
  fetchMs?: number;
  parseMs?: number;
  wallMs?: number;
  truncated?: boolean;
  files?: { path: string; bytes: Uint8Array }[];
  error?: string;
}

export async function handFetch(
  url: string,
  ref?: string,
  opts: { token?: string; maxBytes?: number; fetchImpl?: typeof fetch } = {},
): Promise<FetchResult> {
  const t0 = Date.now();
  try {
    const host = new URL(url).host;
    const auth: AuthRecipe = authForHost(host, opts.token);
    const refs = await checkRefs(url, auth, opts.fetchImpl);
    const { sha, resolvedRef } = resolveWant(refs.adv, ref);

    const up = await uploadPack(url, sha, {
      auth,
      fetchImpl: opts.fetchImpl,
      maxBytes: opts.maxBytes,
    });
    if (up.truncated) {
      return {
        ok: false,
        sha,
        resolvedRef,
        packBytes: up.packBytes.length,
        refsMs: refs.wallMs,
        fetchMs: up.wallMs,
        truncated: true,
        wallMs: Date.now() - t0,
        error: `byte cap hit at ${up.capUsed} bytes`,
      };
    }

    const tp = Date.now();
    const parsed = await parsePack(up.packBytes);
    const files = walkTree(parsed, sha);
    const parseMs = Date.now() - tp;

    let totalBytes = 0;
    for (const f of files) totalBytes += f.bytes.length;

    return {
      ok: true,
      sha,
      resolvedRef,
      fileCount: files.length,
      totalBytes,
      packBytes: up.packBytes.length,
      refsMs: refs.wallMs,
      fetchMs: up.wallMs,
      parseMs,
      wallMs: Date.now() - t0,
      truncated: false,
      files: files.map((f) => ({ path: f.path, bytes: f.bytes })),
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e instanceof Error ? e.message : e),
      wallMs: Date.now() - t0,
    };
  }
}

// refs-only cheap check
export async function handRefsCheck(
  url: string,
  ref?: string,
  opts: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<{
  ok: boolean;
  refCount?: number;
  headSha?: string;
  head?: string;
  sha?: string;
  resolvedRef?: string;
  wallMs?: number;
  error?: string;
}> {
  const t0 = Date.now();
  try {
    const host = new URL(url).host;
    const auth = authForHost(host, opts.token);
    const refs = await checkRefs(url, auth, opts.fetchImpl);
    const head = refs.adv.headTarget;
    const headSha = head ? refs.adv.refs.get(head) : refs.adv.refs.get("HEAD");
    const wanted = resolveWant(refs.adv, ref);
    return {
      ok: true,
      refCount: refs.adv.refs.size,
      head,
      headSha,
      sha: wanted.sha,
      resolvedRef: wanted.resolvedRef,
      wallMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e instanceof Error ? e.message : e),
      wallMs: Date.now() - t0,
    };
  }
}
