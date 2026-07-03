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
import { createServer, type Server } from "node:net";
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

// 400 blocks of 10 ports in 42000..45999: unprivileged and clear of common dev
// servers. NOTE: this range is below macOS's ephemeral range (49152+) but sits
// ENTIRELY inside Linux's default ephemeral range (net.ipv4.ip_local_port_range
// = 32768..60999). On a CI runner any outbound TCP connection the booting stack
// makes (DB dials, emulator warmups, telemetry exporters) can be assigned one of
// these ports as its LOCAL port between claim and bind, causing an EADDRINUSE
// that no other suite triggered. A connect-probe can't see such a squatter
// (nothing is listening on it), so `claimPorts` BIND-probes (holds a listener on
// every claimed port until the instant services take over) and `claimAndBoot`
// retries on EADDRINUSE by re-claiming the next block. We keep the range here
// because it's good for local macOS dev and moving it churns every consumer; the
// bind-probe + retry are what make it safe on Linux CI. Offsets 0-8 are
// claimable; offset 9 is the block's lock port (held for the suite's lifetime to
// make claims atomic across concurrent suites).
const BLOCK_BASE = 42000;
const BLOCK_SIZE = 10;
const BLOCK_COUNT = 400;
const LOCK_OFFSET = BLOCK_SIZE - 1;
export const portBlock = BLOCK_BASE + (hash(repoRoot) % BLOCK_COUNT) * BLOCK_SIZE;

export const e2ePort = (envVar: string, offset: number): number => {
  const fromEnv = process.env[envVar];
  return fromEnv ? Number(fromEnv) : portBlock + offset;
};

const listenOn = (port: number, host: string): Promise<Server | undefined> =>
  new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(undefined));
    server.listen(port, host, () => done(server));
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((done) => server.close(() => done()));

// Bind-probe a single port on BOTH address families and hold both listeners.
// Node's default `listen(port)` binds only `::` (IPv6), and an IPv4 `0.0.0.0`
// listener on the same port coexists with it — so a single-family probe misses
// a squatter on the other family (and our services bind a mix: the WorkOS
// emulator on `::`, vite/dev-db on 127.0.0.1). Binding 0.0.0.0 AND :: means the
// port is only "free" if NEITHER family is taken, and holding both listeners
// keeps it that way until the caller closes them the instant before the real
// services bind. A bind (unlike a connect-probe) also detects an ephemeral
// outbound socket squatting the port. Resolves the held servers on success, or
// undefined if either family was taken (partial binds are closed on failure).
// This shrinks the time-of-check/time-of-use window from seconds (probe, then
// boot) to microseconds (close, then boot).
const bindProbe = async (port: number): Promise<ReadonlyArray<Server> | undefined> => {
  const wanted = ["0.0.0.0", "::"];
  const held = await Promise.all(wanted.map((host) => listenOn(port, host)));
  const ok = held.filter((server): server is Server => server !== undefined);
  if (ok.length !== wanted.length) {
    await Promise.all(ok.map(closeServer));
    return undefined;
  }
  return ok;
};

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
    // BIND-probe every claimed port, holding all probe servers open until the
    // whole block is proven free. A bind (unlike a connect-probe) also detects
    // an ephemeral outbound socket squatting the port, and keeping the probes
    // open means nothing can slip into these ports between the check and the
    // moment we close them just before the services bind.
    const probes = await Promise.all(unpinned.map((claim) => bindProbe(block + claim.offset)));
    const held = probes.flatMap((probe) => probe ?? []);
    if (probes.some((probe) => probe === undefined)) {
      const taken = unpinned
        .filter((_, index) => probes[index] === undefined)
        .map((claim) => `${block + claim.offset} (${claim.label})`);
      await Promise.all(held.map(closeServer)); // Free the ports we did grab.
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
    // Release the probe listeners the instant before we return: the caller boots
    // its services immediately, so the ports go from probe-held to service-held
    // with only a microsecond gap (vs. the seconds a pre-boot probe left open).
    await Promise.all(held.map(closeServer));
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

/** True when an error (or any nested cause) is an EADDRINUSE bind failure. */
export const isAddrInUse = (error: unknown): boolean => {
  for (let cursor: unknown = error; cursor instanceof Error; cursor = cursor.cause) {
    if ((cursor as NodeJS.ErrnoException).code === "EADDRINUSE") return true;
    // The emulate/vite boot glue wraps the OS error in a plain Error whose
    // message carries the code, so match the text too.
    if (/EADDRINUSE/.test(cursor.message)) return true;
  }
  return false;
};

/**
 * Claim a port block and boot the services that bind it, retrying on EADDRINUSE.
 *
 * The bind-probe in `claimPorts` shrinks the claim→bind race to microseconds but
 * cannot close it: on a Linux CI runner (where the whole 42000-45999 range is
 * ephemeral) an outbound socket can still grab a just-released probe port before
 * the service binds it. When that happens the boot throws EADDRINUSE; we release
 * the block (freeing its lock so `claimPorts` walks past it) and re-claim + retry
 * up to `maxAttempts` times. Any non-EADDRINUSE boot failure — or exhausting the
 * retries — releases and rethrows, so a genuinely broken boot still surfaces.
 *
 * `boot` receives the freshly claimed ports and must return its teardown; the
 * returned `teardown` chains the caller's teardown then releases the block.
 */
export const claimAndBoot = async <T>(
  claims: ReadonlyArray<PortClaim>,
  boot: (ports: Record<string, number>) => Promise<{ teardown: () => Promise<void>; value: T }>,
  options: { readonly maxAttempts?: number; readonly label?: string } = {},
): Promise<{ ports: Record<string, number>; teardown: () => Promise<void>; value: T }> => {
  const maxAttempts = options.maxAttempts ?? 3;
  const label = options.label ?? "boot";
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { ports, release } = await claimPorts(claims);
    try {
      const booted = await boot(ports);
      return {
        ports,
        value: booted.value,
        teardown: async () => {
          await booted.teardown();
          await release();
        },
      };
    } catch (error) {
      await release();
      lastError = error;
      if (!isAddrInUse(error) || attempt === maxAttempts) throw error;
      const collided = claims
        .map((claim) => ports[claim.envVar])
        .filter((port): port is number => port !== undefined)
        .join(", ");
      console.warn(
        `[e2e] ${label} hit EADDRINUSE on port(s) ${collided} (attempt ${attempt}/${maxAttempts}); re-claiming a fresh block and retrying`,
      );
    }
  }
  throw lastError;
};
