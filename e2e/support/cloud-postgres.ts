/**
 * The disposable Postgres container a managed Cloud run owns.
 *
 * Docker finishes creating a container even when the client that asked for it has exited, and
 * under load creation can take longer than the run waits. Removal is therefore tied to the
 * container's creation, not to its start: interruption waits for `docker create` to settle and
 * then removes whatever it made. A run killed outright cannot clean up, so each container carries
 * the process that owns it and the process namespace that process ID belongs to, and the next run
 * in that namespace removes those whose owner has exited.
 */
import { Clock, Console, Effect, FileSystem, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const role = "executor.e2e.role=cloud-postgres";
const namespaceLabel = "executor.e2e.pid-namespace";
const pidLabel = "executor.e2e.pid";
/** A container younger than this is never removed by another run, whatever its owner's state. */
const staleAfterMs = 5 * 60_000;

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
    const started = yield* processes.exitCode(docker(["start", container]));
    if (started !== 0)
      return yield* new CloudPostgresFailed({ operation: "Start the Postgres container" });
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
