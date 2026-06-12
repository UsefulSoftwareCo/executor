// Per-checkout port derivation: every checkout (main repo, agent worktree,
// /tmp rig) gets its own deterministic block of e2e ports, so concurrent
// suites never fight over a shared default. The collision failure mode is
// brutal: vite's --strictPort exit is swallowed by the boot glue and
// waitForHttp happily attaches to the OTHER checkout's server, failing dozens
// of scenarios with baffling auth errors instead of one clear bind error.
// Individual E2E_*_PORT env vars still override, and E2E_<TARGET>_URL still
// attaches to a running instance.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root identifies the checkout (stable regardless of process cwd). */
export const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// FNV-1a — tiny, deterministic, and the same value in every process of this
// checkout (globalsetup and test workers must agree on the ports).
const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

// 400 blocks of 10 ports in 42000..45999: unprivileged, clear of common dev
// servers, and below macOS's ephemeral range (49152+).
export const portBlock = 42000 + (hash(repoRoot) % 400) * 10;

export const e2ePort = (envVar: string, offset: number): number => {
  const fromEnv = process.env[envVar];
  return fromEnv ? Number(fromEnv) : portBlock + offset;
};
