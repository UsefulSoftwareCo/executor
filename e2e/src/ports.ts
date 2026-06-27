// Per-checkout port derivation: every checkout (main repo, agent worktree,
// /tmp rig) hashes its repo root into a PREFERRED block of e2e ports, so
// concurrent suites normally never fight over a shared default. The hash is
// only a preference, not a guarantee (28 checkouts over 400 blocks is
// birthday-paradox territory), the globalsetups call `claimPorts`, which
// probes the preferred block and walks forward to the next fully-free one,
// then publishes the claimed ports via the E2E_*_PORT env vars so vitest's
// test workers (spawned after globalsetup) compute the same URLs. The
// collision failure mode this kills is brutal: vite's --strictPort exit is
// swallowed by the boot glue and waitForHttp happily attaches to the OTHER
// checkout's server, failing dozens of scenarios with baffling auth errors
// instead of one clear bind error. Individual E2E_*_PORT env vars still
// override everything, and E2E_<TARGET>_URL still attaches to a running
// instance.
import { randomUUID } from "node:crypto";
import { connect, createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root identifies the checkout (stable regardless of process cwd). */
export const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// FNV-1a is tiny, deterministic, and the same value in every process of this
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

const isListeningOn = (port: number, host: string): Promise<boolean> =>
  new Promise((done) => {
    const socket = connect({ port, host });
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

const isListening = async (port: number): Promise<boolean> => {
  const listening = await Promise.all([
    isListeningOn(port, "127.0.0.1"),
    isListeningOn(port, "::1"),
  ]);
  return listening.some(Boolean);
};

export interface PortClaim {
  readonly envVar: string;
  readonly offset: number;
  readonly label: string;
}

export interface ClaimedPorts {
  readonly ports: Record<string, number>;
  /** Releases this claim and closes an otherwise-unused block lock. */
  readonly release: () => Promise<void>;
}

interface PortReservation {
  readonly id: string;
  readonly envVar: string;
  readonly offset: number;
  readonly label: string;
}

interface HeldBlock {
  readonly server: Server;
  readonly reservations: Map<number, PortReservation>;
  readonly claimIds: Set<string>;
}

// Binding is atomic where probing is not: holding the block's lock port for
// the suite's lifetime means two suites racing for the same block can never
// both win (the second bind EADDRINUSEs and walks on).
const tryLockBlock = (block: number): Promise<Server | undefined> =>
  new Promise((done) => {
    const server = createServer();
    const failed = () => done(undefined);
    server.once("error", failed);
    server.listen(block + LOCK_OFFSET, "127.0.0.1", () => {
      server.off("error", failed);
      done(server);
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((done, fail) => {
    // oxlint-disable-next-line executor/no-promise-reject -- boundary: node:net exposes close failure only through this callback
    server.close((error) => (error ? fail(error) : done()));
  });

const validPort = (port: number): boolean => Number.isInteger(port) && port > 0 && port <= 65_535;

const validateClaims = (claims: ReadonlyArray<PortClaim>): void => {
  const envVars = new Set<string>();
  const offsets = new Set<number>();
  for (const claim of claims) {
    if (envVars.has(claim.envVar)) throw new Error(`e2e: duplicate port env var ${claim.envVar}`);
    envVars.add(claim.envVar);
    if (!Number.isInteger(claim.offset) || claim.offset < 0 || claim.offset >= LOCK_OFFSET) {
      throw new Error(
        `e2e: ${claim.label} offset ${claim.offset} is outside the claimable 0-${LOCK_OFFSET - 1} range`,
      );
    }
    if (offsets.has(claim.offset)) {
      throw new Error(`e2e: duplicate port offset ${claim.offset} in one claim`);
    }
    offsets.add(claim.offset);
  }
};

let operationQueue: Promise<void> = Promise.resolve();

/** Serialize claims and releases so in-process global setups cannot race. */
const serialize = <A>(operation: () => Promise<A>): Promise<A> => {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

/**
 * Claim a free set of ports for a target and publish them via env. Starts at
 * this checkout's preferred block and walks forward block-by-block until it
 * can atomically lock a block whose requested ports are all free, so two
 * checkouts whose hashes collide (or a leaked server squatting the preferred
 * block) degrade to "boot one block over" instead of attaching to a foreign
 * server. Explicit env overrides still mean this suite will spawn on that
 * exact port, so they are probed and fail immediately when occupied. Attaching
 * to an existing instance is a separate E2E_<TARGET>_URL mode and never calls
 * this function. A target re-claiming inside an already-locked process (cloud
 * + selfhost projects in one vitest run) shares the block via disjoint offsets.
 */
const claimPortsUnlocked = async (claims: ReadonlyArray<PortClaim>): Promise<ClaimedPorts> => {
  validateClaims(claims);
  const claimId = randomUUID();
  const ports: Record<string, number> = {};
  const previousEnv = new Map<string, string | undefined>();
  const unpinned = claims.filter((claim) => {
    if (publishedEnvVars.has(claim.envVar)) {
      throw new Error(`e2e: ${claim.envVar} is already owned by an active port claim`);
    }
    const pinned = process.env[claim.envVar];
    previousEnv.set(claim.envVar, pinned);
    if (pinned === undefined || pinned === "") return true;
    const port = Number(pinned);
    if (!validPort(port)) {
      throw new Error(`e2e: ${claim.envVar} must be a port in 1-65535, got ${pinned}`);
    }
    ports[claim.envVar] = port;
    return false;
  });
  if (new Set(Object.values(ports)).size !== Object.values(ports).length) {
    throw new Error("e2e: two explicitly pinned claims use the same port");
  }
  for (const [envVar, port] of Object.entries(ports)) {
    if (activePinnedPorts.has(port)) {
      throw new Error(`e2e: ${envVar}=${port} conflicts with another active pinned claim`);
    }
  }
  const busyPinned = (
    await Promise.all(
      Object.entries(ports).map(async ([envVar, port]) => ({
        envVar,
        port,
        busy: await isListening(port),
      })),
    )
  ).filter((entry) => entry.busy);
  if (busyPinned.length > 0) {
    throw new Error(
      `e2e: explicitly pinned spawn ${busyPinned.map(({ envVar, port }) => `${envVar}=${port}`).join(", ")} is already listening; use E2E_<TARGET>_URL for attach mode`,
    );
  }
  if (unpinned.length === 0) {
    for (const port of Object.values(ports)) activePinnedPorts.set(port, claimId);
    let releaseRequested = false;
    return {
      ports,
      release: () => {
        if (releaseRequested) return Promise.resolve();
        releaseRequested = true;
        return serialize(async () => {
          for (const port of Object.values(ports)) {
            if (activePinnedPorts.get(port) === claimId) activePinnedPorts.delete(port);
          }
        });
      },
    };
  }

  const pinnedPorts = new Set([...Object.values(ports), ...activePinnedPorts.keys()]);

  for (let attempt = 0; attempt < BLOCK_COUNT; attempt++) {
    const block =
      BLOCK_BASE + ((portBlock - BLOCK_BASE + attempt * BLOCK_SIZE) % (BLOCK_COUNT * BLOCK_SIZE));
    if (pinnedPorts.has(block + LOCK_OFFSET)) {
      console.warn(
        `[e2e] port block ${block} lock conflicts with an explicitly pinned port; trying next block`,
      );
      continue;
    }
    // This process may already hold the block's lock (the other target's
    // globalsetup in the same vitest run); reuse it instead of re-locking.
    let held = heldBlocks.get(block);
    const reused = held !== undefined;
    if (!held) {
      const server = await tryLockBlock(block);
      if (!server) {
        console.warn(`[e2e] port block ${block} is locked by another suite; trying next block`);
        continue;
      }
      held = { server, reservations: new Map(), claimIds: new Set() };
      heldBlocks.set(block, held);
    }

    const reserved = unpinned.filter((claim) => held.reservations.has(claim.offset));
    if (reserved.length > 0) {
      const conflicts = reserved.map((claim) => {
        const owner = held.reservations.get(claim.offset);
        return `${block + claim.offset} (${claim.label}, already ${owner?.label ?? "reserved"})`;
      });
      console.warn(
        `[e2e] port block ${block} has in-process offset conflicts: ${conflicts.join(", ")}; trying next block`,
      );
      continue;
    }

    const busy = await Promise.all(
      unpinned.map((claim) =>
        pinnedPorts.has(block + claim.offset)
          ? Promise.resolve(true)
          : isListening(block + claim.offset),
      ),
    );
    if (busy.some(Boolean)) {
      const taken = unpinned
        .filter((_, index) => busy[index])
        .map((claim) => `${block + claim.offset} (${claim.label})`);
      console.warn(
        `[e2e] port block ${block} has squatters: ${taken.join(", ")}; trying next block`,
      );
      if (!reused) {
        heldBlocks.delete(block);
        await closeServer(held.server);
      }
      continue;
    }

    for (const port of Object.values(ports)) activePinnedPorts.set(port, claimId);
    for (const claim of unpinned) {
      const port = block + claim.offset;
      ports[claim.envVar] = port;
      // Workers spawn after globalsetup, so they inherit these and agree.
      process.env[claim.envVar] = String(port);
      publishedEnvVars.set(claim.envVar, claimId);
      held.reservations.set(claim.offset, { ...claim, id: claimId });
    }
    held.claimIds.add(claimId);
    let releaseRequested = false;
    return {
      ports,
      release: () => {
        if (releaseRequested) return Promise.resolve();
        releaseRequested = true;
        return serialize(async () => {
          const current = heldBlocks.get(block);
          for (const port of Object.values(ports)) {
            if (activePinnedPorts.get(port) === claimId) activePinnedPorts.delete(port);
          }
          for (const claim of unpinned) {
            if (publishedEnvVars.get(claim.envVar) === claimId) {
              publishedEnvVars.delete(claim.envVar);
            }
            const published = ports[claim.envVar];
            if (process.env[claim.envVar] === String(published)) {
              const previous = previousEnv.get(claim.envVar);
              if (previous === undefined) delete process.env[claim.envVar];
              else process.env[claim.envVar] = previous;
            }
          }
          if (!current || !current.claimIds.delete(claimId)) return;
          for (const [offset, reservation] of current.reservations) {
            if (reservation.id === claimId) current.reservations.delete(offset);
          }
          if (current.claimIds.size > 0) return;
          heldBlocks.delete(block);
          await closeServer(current.server);
        });
      },
    };
  }
  throw new Error("e2e: no free port block found; the 42000-45999 range is exhausted?");
};

export const claimPorts = (claims: ReadonlyArray<PortClaim>): Promise<ClaimedPorts> =>
  serialize(() => claimPortsUnlocked(claims));

const heldBlocks = new Map<number, HeldBlock>();
const publishedEnvVars = new Map<string, string>();
const activePinnedPorts = new Map<number, string>();
