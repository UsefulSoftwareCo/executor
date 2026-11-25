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
const staleAfterMs = 5 * 60_000;

export const volumeLabels = {
  role: "executor.e2e.role",
  boot: "executor.e2e.boot",
  namespace: "executor.e2e.owner-namespace",
  pid: "executor.e2e.owner-pid",
  started: "executor.e2e.owner-started",
} as const;
const volumeRole = "cloud-postgres-data";
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
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

type DockerEnv = {
  readonly PATH: string;
  readonly DOCKER_HOST: string;
  readonly DOCKER_CONFIG: string;
};

const pidNamespace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (process.platform === "linux") {
    const boot = (yield* fs.readFileString("/proc/sys/kernel/random/boot_id")).trim();
    const namespace = yield* fs.readLink("/proc/self/ns/pid");
    return uuid.test(boot) && /^pid:\[\d+\]$/.test(namespace)
      ? `linux/${boot}/${namespace}`
      : undefined;
  }
  if (process.platform === "darwin") {
    const boot = (yield* processes.string(
      ChildProcess.make("sysctl", ["-n", "kern.bootsessionuuid"]),
    )).trim();
    return uuid.test(boot) ? `darwin/${boot}` : undefined;
  }
  return undefined;
}).pipe(Effect.orElseSucceed(() => undefined));

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

export interface VolumeOwner {
  readonly boot: string;
  readonly namespace: string;
  readonly pid: number;
  readonly started: string;
}

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export const processStarted = (pid: number) =>
  Effect.gen(function* () {
    if (!running(pid)) return Option.none<string>();
    if (process.platform === "linux") {
      const fs = yield* FileSystem.FileSystem;
      const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
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
  }).pipe(Effect.orElseSucceed(() => (running(pid) ? undefined : Option.none<string>())));

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

export interface SweptVolume {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly createdAt: number;
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
    if (!(now - volume.createdAt > staleAfterMs)) return { remove: false, why: "young" };
    if (boot !== here.boot) return { remove: true, why: "another boot" };
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

export const startCloudPostgres = (input: {
  readonly container: string;
  readonly databasePort: number;
  readonly databasePassword: string;
  readonly dockerEnv: DockerEnv;
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
    const namespace = yield* pidNamespace;
    if (namespace !== undefined) yield* removeAbandoned(dockerEnv, namespace);
    const owner = yield* volumeOwner;
    if (owner !== undefined) yield* removeAbandonedVolumes(dockerEnv, owner);
    const volume = `${container}-data`;
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
