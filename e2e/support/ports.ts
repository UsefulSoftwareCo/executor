/** Scoped loopback listeners for isolated ports and real bind-conflict fixtures. */
import { connect, createServer, type Socket } from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Option, Path, Random } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { driver } from "./platform.ts";

/**
 * Hold a loopback port until the owning scope closes; zero asks the OS to choose. `onConnection`
 * handles each connection; the scope closes once every connection has ended.
 */
export const holdPort = (port: number, onConnection?: (socket: Socket) => void) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => createServer(onConnection)),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    return yield* driver(
      "allocate isolated port",
      () =>
        new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") reject(new Error("No test port"));
            else resolve(address.port);
          });
        }),
    );
  });

/**
 * Where isolated ports come from: below the ephemeral ranges of Linux (32768-60999), macOS and
 * Windows (49152-65535). The OS hands ephemeral ports to every socket that binds port zero or
 * connects out, so a port in that range that a server frees, even for a moment while it restarts,
 * can go to another socket before the server binds it again. Only explicit binds take ports in
 * this range, and the harness takes them only through the reservations below.
 */
const isolatedPorts = { from: 20_000, to: 32_767 } as const;

/** The range the OS hands out for port zero and outgoing connections, read from the OS. */
const ephemeralRange = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const numbers = (text: string) =>
    text
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((value) => Number.isInteger(value));
  if (process.platform === "win32") {
    const shown = yield* processes.string(
      ChildProcess.make("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"]),
    );
    const from = Number(/Start Port\s*:\s*(\d+)/.exec(shown)?.[1]);
    const count = Number(/Number of Ports\s*:\s*(\d+)/.exec(shown)?.[1]);
    return { from, to: from + count - 1 };
  }
  const [from = Number.NaN, to = Number.NaN] =
    process.platform === "linux"
      ? numbers(yield* fs.readFileString("/proc/sys/net/ipv4/ip_local_port_range"))
      : numbers(
          yield* processes.string(
            ChildProcess.make("sysctl", [
              "-n",
              "net.inet.ip.portrange.first",
              "net.inet.ip.portrange.last",
            ]),
          ),
        );
  return { from, to };
}).pipe(Effect.orDie);

let rangeChecked = false;
/** Fail unless the OS's ephemeral range leaves the isolated ports alone. */
const checkEphemeralRange = Effect.gen(function* () {
  if (rangeChecked) return;
  const ephemeral = yield* ephemeralRange;
  if (!Number.isInteger(ephemeral.from) || !Number.isInteger(ephemeral.to))
    return yield* Effect.die(new Error("Could not read the OS's ephemeral port range"));
  if (ephemeral.to >= isolatedPorts.from && ephemeral.from <= isolatedPorts.to)
    return yield* Effect.die(
      new Error(
        `The OS hands out ports ${ephemeral.from}-${ephemeral.to}, which overlaps the isolated ports ${isolatedPorts.from}-${isolatedPorts.to}; a freed test port could go to another socket.`,
      ),
    );
  rangeChecked = true;
});

/**
 * Every isolated port the harness holds on this machine, across suites and worker processes: one
 * file per port in the temporary directory, created exclusively and naming its owner's PID, as the
 * host slots in e2e/host-slot.ts do. No two live owners ever hold the same port. A dead owner's
 * file is removed only by whoever holds that port's reclaim lock, so no claim can remove a live
 * owner's file: a file naming a dead owner changes only when the lock's holder removes it.
 */
const registry = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(process.env.TMPDIR ?? process.env.TEMP ?? "/tmp", "executor-e2e-ports");
  yield* fs.makeDirectory(root, { recursive: true });
  return { fs, file: (port: number) => path.join(root, String(port)) };
}).pipe(Effect.orDie);

const owner = String(process.pid);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** Whether the file names a live owner. An empty file is one an owner is still writing. */
const liveOwner = (named: string) => {
  const pid = Number(named);
  return named === "" || !Number.isInteger(pid) || pid <= 0 || alive(pid);
};

/** Hold `port` for this process in the machine's registry, or return false if a live owner does. */
const claim = (port: number) =>
  Effect.gen(function* () {
    const { fs, file } = yield* registry;
    const create = (name: string) =>
      fs.writeFileString(name, owner, { flag: "wx", mode: 0o600 }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
    if (yield* create(file(port))) return true;
    const lock = `${file(port)}.reclaim`;
    if (!(yield* create(lock))) return false;
    return yield* Effect.gen(function* () {
      const named = yield* Effect.option(fs.readFileString(file(port)));
      if (Option.isSome(named)) {
        if (liveOwner(named.value)) return false;
        yield* fs.remove(file(port));
      }
      return yield* create(file(port));
    }).pipe(Effect.ensuring(Effect.ignore(fs.remove(lock))));
  }).pipe(Effect.orDie);

const release = (port: number) =>
  Effect.gen(function* () {
    const { fs, file } = yield* registry;
    const named = yield* Effect.option(fs.readFileString(file(port)));
    if (Option.isSome(named) && named.value === owner) yield* Effect.ignore(fs.remove(file(port)));
  });

/** An isolated port this process now holds in the registry and that nothing listens on. */
const claimIsolatedPort = Effect.gen(function* () {
  yield* checkEphemeralRange;
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = yield* Random.nextIntBetween(isolatedPorts.from, isolatedPorts.to);
    if (!(yield* claim(port))) continue;
    if (Option.isSome(yield* Effect.option(Effect.scoped(holdPort(port))))) return port;
    yield* release(port);
  }
  return yield* Effect.die(new Error("No free loopback port outside the ephemeral range"));
}).pipe(Effect.provide(NodeServices.layer));

/**
 * A loopback port outside the OS's ephemeral range that no other part of the harness on this
 * machine can be given while this process runs. Nothing listens on it when it returns.
 */
export const freePort = claimIsolatedPort;

/**
 * As `freePort`, held until the scope closes. A product keeps this port while it stops and starts
 * again: the OS does not hand it out, and no other reservation can take it in between.
 */
export const reservedPort = Effect.acquireRelease(claimIsolatedPort, (port) =>
  release(port).pipe(Effect.provide(NodeServices.layer)),
);

/**
 * Try to reserve exactly `port`, as any other part of the harness would, until the scope closes.
 * False when another live owner holds it. For the harness's own test.
 */
export const reservePortAt = (port: number) =>
  Effect.acquireRelease(claim(port), (claimed) => (claimed ? release(port) : Effect.void)).pipe(
    Effect.provide(NodeServices.layer),
  );

/** Whether a live owner on this machine holds `port` in the registry. For the harness's own test. */
export const portReserved = (port: number) =>
  Effect.gen(function* () {
    const { fs, file } = yield* registry;
    const named = yield* Effect.option(fs.readFileString(file(port)));
    return Option.isSome(named) && named.value !== "" && liveOwner(named.value);
  }).pipe(Effect.provide(NodeServices.layer));

/** Whether the OS can hand `port` to a socket that binds port zero or connects out. */
export const ephemeralPort = (port: number) =>
  ephemeralRange.pipe(
    Effect.map((range) => port >= range.from && port <= range.to),
    Effect.provide(NodeServices.layer),
  );

/**
 * A loopback port that refuses connections until the owning scope closes. A port released by
 * `freePort` can be handed to another worker's server before the scenario connects to it, and
 * then something answers. Here an open loopback connection keeps the port as its local end, so
 * the OS gives it to no other socket, while nothing listens on it.
 */
export const refusingPort = Effect.gen(function* () {
  const peer = yield* holdPort(0);
  const socket = yield* Effect.acquireRelease(
    driver(
      "reserve refusing port",
      () =>
        new Promise<Socket>((resolve, reject) => {
          const socket = connect({ host: "127.0.0.1", port: peer });
          socket.once("error", reject);
          socket.once("connect", () => resolve(socket));
        }),
    ),
    (socket) => Effect.sync(() => socket.destroy()),
  );
  const port = socket.localPort;
  if (port === undefined) return yield* Effect.die("The reserved socket has no local port");
  return port;
});

/** Whether a loopback connection to `port` is refused, the only sign that nothing listens there. */
export const connectionRefused = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (refused: boolean) => {
      socket.destroy();
      resume(Effect.succeed(refused));
    };
    socket.once("connect", () => settle(false));
    socket.once("error", (error) => settle("code" in error && error.code === "ECONNREFUSED"));
    return Effect.sync(() => socket.destroy());
  });
