// Per-checkout port derivation: every checkout (main repo, agent worktree,
// /tmp rig) hashes its repo root into a PREFERRED block of e2e ports, so
// concurrent suites normally never fight over a shared default. The hash is
// only a preference, not a guarantee (28 checkouts over 400 blocks is
// birthday-paradox territory) — the globalsetups call `claimPorts`, which
// probes the preferred block and walks forward to the next fully-free one,
// then publishes the claimed ports via the E2E_*_PORT env vars so vitest's
// test workers (spawned after globalsetup) compute the same URLs. The
// collision failure mode this kills is brutal: vite's --strictPort exit is
// swallowed by the boot glue and waitForHttp happily attaches to the OTHER
// checkout's server, failing dozens of scenarios with baffling auth errors
// instead of one clear bind error. Individual E2E_*_PORT env vars still
// override everything, and E2E_<TARGET>_URL still attaches to a running
// instance.
import { connect, createServer, type Server } from "node:net";
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
// servers, and below macOS's ephemeral range (49152+). Offsets 0-8 are
// claimable; offset 9 is the block's lock port (held for the suite's
// lifetime to make claims atomic across concurrent suites).
const BLOCK_BASE = 42000;
const BLOCK_SIZE = 10;
const BLOCK_COUNT = 400;
const LOCK_OFFSET = BLOCK_SIZE - 1;
export const portBlock = BLOCK_BASE + (hash(repoRoot) % BLOCK_COUNT) * BLOCK_SIZE;

export const e2ePort = (envVar: string, offset: number): number => {
  const fromEnv = process.env[envVar];
  return fromEnv ? Number(fromEnv) : portBlock + offset;
};

const isListening = (port: number): Promise<boolean> =>
  new Promise((done) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      done(false);
    });
  });

export interface PortClaim {
  readonly envVar: string;
  readonly offset: number;
  readonly label: string;
}

export interface ClaimedPorts {
  readonly ports: Record<string, number>;
  /** Releases the block's lock port — call from the suite teardown. */
  readonly release: () => Promise<void>;
}

// Binding is atomic where probing is not: holding the block's lock port for
// the suite's lifetime means two suites racing for the same block can never
// both win (the second bind EADDRINUSEs and walks on).
const tryLockBlock = (block: number): Promise<Server | undefined> =>
  new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(undefined));
    server.listen(block + LOCK_OFFSET, "127.0.0.1", () => done(server));
  });

/**
 * Claim a free set of ports for a target and publish them via env. Starts at
 * this checkout's preferred block and walks forward block-by-block until it
 * can atomically lock a block whose requested ports are all free — so two
 * checkouts whose hashes collide (or a leaked server squatting the preferred
 * block) degrade to "boot one block over" instead of attaching to a foreign
 * server. Explicit env overrides win and are never probed or locked: if you
 * pin a port and it's busy, vite's --strictPort fails visibly. A target
 * re-claiming inside an already-locked process (cloud + selfhost projects in
 * one vitest run) shares the block via disjoint offsets.
 */
export const claimPorts = async (claims: ReadonlyArray<PortClaim>): Promise<ClaimedPorts> => {
  const ports: Record<string, number> = {};
  const unpinned = claims.filter((claim) => {
    const pinned = process.env[claim.envVar];
    if (pinned) ports[claim.envVar] = Number(pinned);
    return !pinned;
  });
  if (unpinned.length === 0) return { ports, release: async () => {} };

  for (let attempt = 0; attempt < BLOCK_COUNT; attempt++) {
    const block =
      BLOCK_BASE + ((portBlock - BLOCK_BASE + attempt * BLOCK_SIZE) % (BLOCK_COUNT * BLOCK_SIZE));
    // This process may already hold the block's lock (the other target's
    // globalsetup in the same vitest run); reuse it instead of re-locking.
    let lock = heldLocks.get(block);
    if (!lock) {
      lock = await tryLockBlock(block);
      if (!lock) {
        console.warn(`[e2e] port block ${block} is locked by another suite; trying next block`);
        continue;
      }
      heldLocks.set(block, lock);
    }
    const busy = await Promise.all(unpinned.map((claim) => isListening(block + claim.offset)));
    if (busy.some(Boolean)) {
      const taken = unpinned
        .filter((_, index) => busy[index])
        .map((claim) => `${block + claim.offset} (${claim.label})`);
      console.warn(
        `[e2e] port block ${block} has squatters — ${taken.join(", ")}; trying next block`,
      );
      continue; // Keep the lock: a half-busy block is still ours, just unusable now.
    }
    for (const claim of unpinned) {
      const port = block + claim.offset;
      ports[claim.envVar] = port;
      // Workers spawn after globalsetup, so they inherit these and agree.
      process.env[claim.envVar] = String(port);
    }
    return {
      ports,
      release: async () => {
        const held = heldLocks.get(block);
        if (!held) return;
        heldLocks.delete(block);
        await new Promise<void>((done) => held.close(() => done()));
      },
    };
  }
  throw new Error("e2e: no free port block found — the 42000-45999 range is exhausted?");
};

const heldLocks = new Map<number, Server>();
