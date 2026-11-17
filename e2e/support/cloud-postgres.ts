/**
 * The disposable Postgres container a managed Cloud run owns.
 *
 * Docker finishes creating a container even when the client that asked for it has exited, and
 * under load creation can take longer than the run waits. Removal is therefore tied to the
 * container's creation, not to its start: interruption waits for `docker create` to settle and
 * then removes whatever it made. A run killed outright cannot clean up, so each container carries
 * the process that owns it and the process namespace that process ID belongs to, and the next run
 * in that namespace removes those whose owner has exited.
 *
 * The database's files live in a named volume of the run's own. A container that vanishes by any
 * other route than this run's teardown (a hand-run `docker rm -f`, a prune, a daemon restart, a
 * reboot) would otherwise leave an anonymous volume nothing names. The volume carries the boot,
 * the process namespace, and the owning process's ID with the start time the operating system
 * keeps for it, so a later run can tell for certain that its owner is gone (`volumeVerdict`).
 */
import {
  Clock,
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const role = "executor.e2e.role=cloud-postgres";
const namespaceLabel = "executor.e2e.pid-namespace";
const pidLabel = "executor.e2e.pid";
/** A container younger than this is never removed by another run, whatever its owner's state. */
const staleAfterMs = 5 * 60_000;

/** The labels of a run's database volume. Only volumes with the role label are ever listed. */
export const volumeLabels = {
  role: "executor.e2e.role",
  boot: "executor.e2e.boot",
  namespace: "executor.e2e.owner-namespace",
  pid: "executor.e2e.owner-pid",
  started: "executor.e2e.owner-started",
} as const;
const volumeRole = "cloud-postgres-data";
/** How long the sweep of abandoned volumes may take before the run goes on without it. */
const sweepTimeout = Duration.seconds(30);

class CloudPostgresFailed extends Schema.TaggedError<CloudPostgresFailed>()("CloudPostgresFailed", {
  operation: Schema.String,
}) {
  get message() {
    return `Cloud test environment failed: ${this.operation}`;
  }
}

const Containers = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Id: Schema.String,
      Created: Schema.String,
      Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
    }),
  ),
);

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

type DockerEnv = {
  readonly PATH: string;
  readonly DOCKER_HOST: string;
  readonly DOCKER_CONFIG: string;
};

/**
 * The process-ID namespace this run belongs to, or undefined when it cannot be established.
 * Runs sharing a Docker daemon, and even a hostname, may sit in different containers or
 * machines; a process ID tells whether its owner is alive only within the namespace that issued it.
 */
const pidNamespace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (process.platform === "linux") {
    // A namespace's inode is unique among live namespaces of one boot of one kernel.
    const boot = (yield* fs.readFileString("/proc/sys/kernel/random/boot_id")).trim();
    const namespace = yield* fs.readLink("/proc/self/ns/pid");
    return uuid.test(boot) && /^pid:\[\d+\]$/.test(namespace)
      ? `linux/${boot}/${namespace}`
      : undefined;
  }
  if (process.platform === "darwin") {
    // macOS has one process namespace per boot.
    const boot = (yield* processes.string(
      ChildProcess.make("sysctl", ["-n", "kern.bootsessionuuid"]),
    )).trim();
    return uuid.test(boot) ? `darwin/${boot}` : undefined;
  }
  return undefined;
}).pipe(Effect.orElseSucceed(() => undefined));

/** Remove this namespace's Cloud test databases whose owning run has exited. */
const removeAbandoned = (dockerEnv: DockerEnv, namespace: string) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const docker = (args: ReadonlyArray<string>) =>
      ChildProcess.make("docker", args, { env: dockerEnv, extendEnv: false });
    const ids = (yield* processes.string(
      docker([
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `label=${role}`,
        "--filter",
        `label=${namespaceLabel}=${namespace}`,
      ]),
    ))
      .split("\n")
      .filter((id) => id.length > 0);
    if (ids.length === 0) return;
    const now = yield* Clock.currentTimeMillis;
    const abandoned = (yield* processes
      .string(docker(["inspect", ...ids]))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Containers))))
      .filter(
        (container) =>
          now - Date.parse(container.Created) > staleAfterMs &&
          !running(Number(container.Config.Labels[pidLabel])),
      )
      .map((container) => container.Id);
    if (abandoned.length === 0) return;
    // Another run may be removing the same container; its exit status is not this run's failure.
    const [code, errors] = yield* Effect.scoped(
      Effect.gen(function* () {
        const rm = yield* processes.spawn(
          ChildProcess.make("docker", ["rm", "--force", "--volumes", ...abandoned], {
            env: dockerEnv,
            extendEnv: false,
            stdout: "ignore",
            stderr: "pipe",
          }),
        );
        return yield* Effect.all([rm.exitCode, Stream.mkString(Stream.decodeText(rm.stderr))], {
          concurrency: 2,
        });
      }),
    );
    if (code !== 0)
      yield* Console.error(
        `Cannot remove abandoned Cloud test databases ${abandoned.join(", ")}: ${errors.trim()}`,
      );
  });

/**
 * This run as its database volume records it, or undefined where a process's start time cannot
 * be read. Linux: the boot ID, the pid and time namespaces (start times count clock ticks from
 * boot, as the reader's time namespace sees them), and field 22 of `/proc/self/stat`. macOS: the
 * boot session UUID, one process namespace per boot, and the second `ps` says the process
 * started, in UTC. Elsewhere volumes carry no owner and are never swept.
 */
export interface VolumeOwner {
  readonly boot: string;
  readonly namespace: string;
  readonly pid: number;
  readonly started: string;
}

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * When process `pid` started, as `VolumeOwner.started` records it. None when no process has the
 * pid, or only one that has exited; undefined when the operating system did not say.
 */
export const processStarted = (pid: number) =>
  Effect.gen(function* () {
    if (!running(pid)) return Option.none<string>();
    if (process.platform === "linux") {
      const fs = yield* FileSystem.FileSystem;
      const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
      // The command name, field 2, is in parentheses and may hold spaces; field 3 follows it.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const [state, started] = [fields[0], fields[19]];
      if (state === undefined || started === undefined || !/^\d+$/.test(started)) return undefined;
      return state === "Z" || state === "X" ? Option.none<string>() : Option.some(started);
    }
    if (process.platform === "darwin") {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const output = (yield* processes.string(
        ChildProcess.make("/bin/ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], {
          env: { LC_ALL: "C", TZ: "UTC0" },
        }),
      )).trim();
      const match = /^(\S+)\s+(\S.*)$/.exec(output);
      if (match === null) return undefined;
      const [, state = "", started = ""] = match;
      return state.startsWith("Z") ? Option.none<string>() : Option.some(started);
    }
    return undefined;
  }).pipe(
    // A process that exits while it is read leaves nothing to read.
    Effect.orElseSucceed(() => (running(pid) ? undefined : Option.none<string>())),
  );

const volumeOwner = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const started = yield* processStarted(process.pid);
  if (started === undefined || Option.isNone(started)) return undefined;
  if (process.platform === "linux") {
    const boot = (yield* fs.readFileString("/proc/sys/kernel/random/boot_id")).trim();
    const pids = yield* fs.readLink("/proc/self/ns/pid");
    const time = yield* fs
      .readLink("/proc/self/ns/time")
      .pipe(Effect.orElseSucceed(() => "time:none"));
    if (!uuid.test(boot) || !/^pid:\[\d+\]$/.test(pids)) return undefined;
    return {
      boot,
      namespace: `linux/${boot}/${pids}/${time}`,
      pid: process.pid,
      started: started.value,
    };
  }
  if (process.platform === "darwin") {
    const boot = (yield* processes.string(
      ChildProcess.make("sysctl", ["-n", "kern.bootsessionuuid"]),
    )).trim();
    if (!uuid.test(boot)) return undefined;
    return { boot, namespace: `darwin/${boot}`, pid: process.pid, started: started.value };
  }
  return undefined;
}).pipe(Effect.orElseSucceed((): VolumeOwner | undefined => undefined));

/** A run's database volume as the sweep sees it. */
export interface SweptVolume {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly createdAt: number;
  /** How many containers, running or stopped, mount it. */
  readonly mountedBy: number;
}

export type VolumeVerdict =
  | { readonly remove: true; readonly why: "another boot" | "owner exited" | "owner's pid reused" }
  | {
      readonly remove: false;
      readonly why:
        | "not ours"
        | "incomplete labels"
        | "mounted"
        | "young"
        | "another process namespace"
        | "owner runs"
        | "owner unknown";
    };

/**
 * Whether the volume's run is certainly gone. Anything short of certain keeps it: leaking a volume
 * is the safe failure, taking a live run's database is not. `started` reads a process's start
 * time as `processStarted` does.
 */
export const volumeVerdict = <R>(
  volume: SweptVolume,
  here: VolumeOwner,
  now: number,
  started: (pid: number) => Effect.Effect<Option.Option<string> | undefined, never, R>,
) =>
  Effect.gen(function* (): Effect.fn.Return<VolumeVerdict, never, R> {
    const labels = volume.labels;
    if (labels[volumeLabels.role] !== volumeRole) return { remove: false, why: "not ours" };
    const boot = labels[volumeLabels.boot] ?? "";
    const namespace = labels[volumeLabels.namespace] ?? "";
    const pid = labels[volumeLabels.pid] ?? "";
    const recorded = labels[volumeLabels.started] ?? "";
    if (!uuid.test(boot) || namespace === "" || !/^[1-9]\d*$/.test(pid) || recorded === "")
      return { remove: false, why: "incomplete labels" };
    if (volume.mountedBy !== 0) return { remove: false, why: "mounted" };
    // Covers the moment between a run creating its volume and its container.
    if (!(now - volume.createdAt > staleAfterMs)) return { remove: false, why: "young" };
    if (boot !== here.boot) return { remove: true, why: "another boot" };
    // A process ID names a process only in the namespace that issued it.
    if (namespace !== here.namespace) return { remove: false, why: "another process namespace" };
    const current = yield* started(Number(pid));
    if (current === undefined) return { remove: false, why: "owner unknown" };
    if (Option.isNone(current)) return { remove: true, why: "owner exited" };
    return current.value === recorded
      ? { remove: false, why: "owner runs" }
      : { remove: true, why: "owner's pid reused" };
  });

const Volumes = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Name: Schema.String,
      CreatedAt: Schema.String,
      Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
);

/**
 * Remove the database volumes, listed by their role label and nothing else, whose run is
 * certainly gone. Never fails the run: what it could not do is reported and the run goes on.
 */
const removeAbandonedVolumes = (dockerEnv: DockerEnv, here: VolumeOwner) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const docker = (args: ReadonlyArray<string>) =>
      ChildProcess.make("docker", args, { env: dockerEnv, extendEnv: false });
    const names = (yield* processes.string(
      docker(["volume", "ls", "--quiet", "--filter", `label=${volumeLabels.role}=${volumeRole}`]),
    ))
      .split("\n")
      .filter((name) => name.length > 0);
    if (names.length === 0) return;
    const volumes = yield* processes
      .string(docker(["volume", "inspect", ...names]))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Volumes)));
    const now = yield* Clock.currentTimeMillis;
    for (const volume of volumes) {
      const mountedBy = (yield* processes.string(
        docker(["ps", "--all", "--quiet", "--filter", `volume=${volume.Name}`]),
      ))
        .split("\n")
        .filter((id) => id.length > 0).length;
      const verdict = yield* volumeVerdict(
        {
          name: volume.Name,
          labels: volume.Labels ?? {},
          createdAt: Date.parse(volume.CreatedAt),
          mountedBy,
        },
        here,
        now,
        processStarted,
      );
      if (!verdict.remove) continue;
      // Not forced: Docker refuses a volume that a container created since the check mounts.
      const [code, errors] = yield* Effect.scoped(
        Effect.gen(function* () {
          const rm = yield* processes.spawn(
            ChildProcess.make("docker", ["volume", "rm", volume.Name], {
              env: dockerEnv,
              extendEnv: false,
              stdout: "ignore",
              stderr: "pipe",
            }),
          );
          return yield* Effect.all([rm.exitCode, Stream.mkString(Stream.decodeText(rm.stderr))], {
            concurrency: 2,
          });
        }),
      );
      yield* code === 0
        ? Console.error(
            `Removed abandoned Cloud test database volume ${volume.Name} (${verdict.why})`,
          )
        : Console.error(
            `Cannot remove abandoned Cloud test database volume ${volume.Name}: ${errors.trim()}`,
          );
    }
  }).pipe(
    Effect.timeout(sweepTimeout),
    Effect.catchCause((cause) =>
      Console.error(`Skipped the sweep of abandoned Cloud test database volumes: ${String(cause)}`),
    ),
  );

/** Create, start and await a Postgres container that is removed when the caller's scope closes. */
export const startCloudPostgres = (input: {
  readonly container: string;
  readonly databasePort: number;
  readonly databasePassword: string;
  readonly dockerEnv: DockerEnv;
  /** Receives the server's output. */
  readonly log: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { container, dockerEnv } = input;
    const docker = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
      ChildProcess.make("docker", args, {
        env: { ...dockerEnv, ...env },
        extendEnv: false,
        stdout: "ignore",
        stderr: "ignore",
      });
    // Without a namespace, a container records no owner another run could check, and this run
    // checks none.
    const namespace = yield* pidNamespace;
    if (namespace !== undefined) yield* removeAbandoned(dockerEnv, namespace);
    // Without a start time, a volume records no owner, and this run sweeps none.
    const owner = yield* volumeOwner;
    if (owner !== undefined) yield* removeAbandonedVolumes(dockerEnv, owner);
    const volume = `${container}-data`;
    // Released after the container, which mounts it. Removal by name is a no-op when nothing was
    // created; a volume that cannot be removed is left for a later run's sweep.
    const volumeCreated = yield* Effect.acquireRelease(
      processes.exitCode(
        docker([
          "volume",
          "create",
          "--label",
          `${volumeLabels.role}=${volumeRole}`,
          ...(owner === undefined
            ? []
            : [
                "--label",
                `${volumeLabels.boot}=${owner.boot}`,
                "--label",
                `${volumeLabels.namespace}=${owner.namespace}`,
                "--label",
                `${volumeLabels.pid}=${owner.pid}`,
                "--label",
                `${volumeLabels.started}=${owner.started}`,
              ]),
          volume,
        ]),
      ),
      () =>
        processes.exitCode(docker(["volume", "rm", "--force", volume])).pipe(
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Console.error(`Cannot remove Cloud test database volume ${volume}`),
          ),
          Effect.catch(() => Console.error(`Cannot remove Cloud test database volume ${volume}`)),
        ),
    );
    if (volumeCreated !== 0)
      return yield* new CloudPostgresFailed({ operation: "Create the Postgres volume" });
    // Acquisition is uninterruptible, so an interrupted run still learns whether Docker created
    // the container before it removes it. Removal by name is a no-op when nothing was created.
    const created = yield* Effect.acquireRelease(
      processes.exitCode(
        docker(
          [
            "create",
            "--rm",
            "--name",
            container,
            "--label",
            role,
            ...(namespace === undefined
              ? []
              : [
                  "--label",
                  `${namespaceLabel}=${namespace}`,
                  "--label",
                  `${pidLabel}=${process.pid}`,
                ]),
            "--volume",
            `${volume}:/var/lib/postgresql/data`,
            "--publish",
            `127.0.0.1:${input.databasePort}:5432`,
            "--env",
            "POSTGRES_USER=executor",
            "--env",
            "POSTGRES_DB=executor",
            "--env",
            "POSTGRES_PASSWORD",
            "postgres:17",
            // The local Worker connects straight to Postgres, without PgBouncer.
            // Parallel browser requests and their background jobs each own SQL
            // connections; PostgreSQL's default 100 slots rejects startup bursts.
            "-c",
            "max_connections=512",
          ],
          { POSTGRES_PASSWORD: input.databasePassword },
        ),
      ),
      () =>
        processes.exitCode(docker(["rm", "--force", "--volumes", container])).pipe(
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.die(new Error("Cannot remove disposable Cloud test database")),
          ),
          Effect.orDie,
        ),
    );
    if (created !== 0)
      return yield* new CloudPostgresFailed({ operation: "Create the Postgres container" });
    // Docker says why a container cannot start, such as its published port being in use.
    const [started, startErrors] = yield* Effect.scoped(
      Effect.gen(function* () {
        const start = yield* processes.spawn(
          ChildProcess.make("docker", ["start", container], {
            env: dockerEnv,
            extendEnv: false,
            stdout: "ignore",
            stderr: "pipe",
          }),
        );
        return yield* Effect.all(
          [start.exitCode, Stream.mkString(Stream.decodeText(start.stderr))],
          { concurrency: 2 },
        );
      }),
    );
    if (started !== 0)
      return yield* new CloudPostgresFailed({
        operation: `Start the Postgres container: ${startErrors.trim()}`,
      });
    const logs = yield* processes.spawn(
      ChildProcess.make("docker", ["logs", "--follow", container], {
        env: dockerEnv,
        extendEnv: false,
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "10 seconds",
      }),
    );
    yield* Stream.merge(logs.stdout, logs.stderr).pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => fs.writeFileString(input.log, text, { flag: "a", mode: 0o600 })),
      Effect.forkScoped,
    );
    // The image starts a temporary Unix-only server during initdb. Wait for its
    // final TCP listener before migrations and fixture setup compete to use it.
    yield* processes
      .exitCode(
        docker([
          "exec",
          container,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "executor",
          "-d",
          "executor",
        ]),
      )
      .pipe(
        Effect.flatMap((code) =>
          code === 0
            ? Effect.void
            : Effect.fail(new CloudPostgresFailed({ operation: "Postgres TCP readiness" })),
        ),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 90 }),
      );
  });
