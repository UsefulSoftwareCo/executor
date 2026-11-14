/**
 * The background service's files in a data directory: the running server's registration, the lock
 * it holds and the settings it starts with. Servers, clients and the desktop share these readers
 * and the lock rule, so all agree on the contract.
 */
import { stat } from "node:fs/promises";
import { connect } from "node:net";
import { hostname } from "node:os";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Clock, Config, Console, Deferred, Effect, FileSystem, Option, Path, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { HttpClient, HttpClientResponse } from "effect/http";
import { lock, type LockOptions } from "proper-lockfile";
import { BrowserSession } from "../contracts/auth.ts";
import {
  dataDirectoryConfig,
  EarlierServerRecord,
  ServiceFailed,
  type ServiceInfo,
  ServiceRegistration,
  ServiceSettingInvalid,
  ServiceSettings,
  serviceLockFile,
  serviceRegistrationFile,
  serviceSettingsFile,
} from "../contracts/service.ts";
import { writeAtomically } from "./atomic-file.ts";
import {
  holdPipe,
  ownProcess,
  PipeName,
  pipeHolder,
  processExists,
  type ProcessState,
  type RecordedProcess,
  recordedProcess,
} from "./process-identity.ts";

/** What a server reports as its version; development builds share one. */
export const serviceVersion = Config.String("EXECUTOR_BUILD_VERSION").pipe(
  Config.withDefault("0.0.0-dev"),
);

/** The absolute data directory this process uses. */
export const serviceDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(yield* dataDirectoryConfig);
});

const RegistrationJson = Schema.fromJsonString(ServiceRegistration);
const EarlierJson = Schema.fromJsonString(EarlierServerRecord);
const SettingsJson = Schema.fromJsonString(ServiceSettings);

/**
 * Whether a TCP connection to `url` is refused, which is the only sign that nothing listens on
 * it. Fetch cannot tell: Bun's, which the release executable runs, reports every failed connect as
 * `ConnectionRefused`, including a connection the peer accepted and reset before Bun saw it
 * complete, as happens on Windows. A plain socket keeps the operating system's error under Node
 * and Bun alike.
 */
export const connectionRefused = (url: URL) =>
  Effect.callback<boolean>((resume) => {
    const socket = connect({
      host: url.hostname.replace(/^\[(.*)\]$/u, "$1"),
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    });
    const settle = (refused: boolean) => {
      socket.destroy();
      resume(Effect.succeed(refused));
    };
    socket.once("connect", () => settle(false));
    socket.once("error", (error) => settle(refusedCode(error)));
    return Effect.sync(() => socket.destroy());
  });
const refusedCode = Schema.is(Schema.Struct({ code: Schema.Literal("ECONNREFUSED") }));

/**
 * How long a `.server.lock` whose owner this machine cannot check, as one without an owner, still
 * counts as held after its last refresh.
 */
export const serviceLockStale = 30_000;
/**
 * Who holds a data directory's `.server.lock`, written inside it, so it always describes that lock:
 * the holder's process, as `ownProcess` records it, on Windows the pipe it listens on while it
 * holds the lock, and its host, which a pipe belongs to, and for messages, for a server, its
 * loopback port.
 */
const ServiceLockOwner = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    started: Schema.optional(Schema.String),
    boot: Schema.optional(Schema.String),
    pipe: Schema.optional(PipeName),
    host: Schema.String,
    port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  }),
);
type ServiceLockOwner = typeof ServiceLockOwner.Type;

/** Whether two records name the same process. */
const sameProcess = (left: RecordedProcess, right: RecordedProcess) =>
  left.pid === right.pid && left.started === right.started && left.boot === right.boot;

const sameOwner = (left: ServiceLockOwner, right: ServiceLockOwner) =>
  sameProcess(left, right) &&
  left.pipe === right.pipe &&
  left.host === right.host &&
  left.port === right.port;

/**
 * Where the process a lock's owner names is now. On Windows its pipe says, when this host recorded
 * it; one another host recorded says nothing here. Elsewhere its start time does.
 */
const ownerProcess = (owner: ServiceLockOwner) =>
  owner.pipe === undefined
    ? recordedProcess(owner)
    : process.platform === "win32" && owner.host === hostname()
      ? pipeHolder(owner.pipe)
      : Effect.succeed<ProcessState>("elsewhere");

/** The owner recorded in the server lock `lock`, if it is readable. */
const readLockOwner = (lock: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs
      .readFileString(path.join(lock, "owner.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ServiceLockOwner)), Effect.option);
  });

/** Whether the server lock `lock` was last refreshed more than `serviceLockStale` ago. */
const lockStale = (lock: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const refreshed = Option.getOrUndefined((yield* fs.stat(lock)).mtime)?.getTime() ?? 0;
    return refreshed < (yield* Clock.currentTimeMillis) - serviceLockStale;
  });

/**
 * Whether the held server lock `lock` was abandoned. A lock whose owner can be checked is held,
 * however stale its time, while that owner runs, as a suspended or sleeping server does: on Linux
 * and macOS while its pid runs on this boot with the start time it recorded, on Windows while the
 * pipe it recorded exists. It is abandoned at once when that process has exited, as after a crash,
 * also when its pid now names another program. A lock with no readable owner may be in the middle
 * of being taken, and one owned on another boot or machine, recorded without a start time or pipe,
 * or whose owner's start time, this boot or its pipe cannot be read now, cannot be checked here, so
 * those count as held until they are 30 seconds stale.
 */
const lockAbandoned = (lock: string) =>
  Effect.gen(function* () {
    const owner = yield* readLockOwner(lock);
    const state = Option.isSome(owner) ? yield* ownerProcess(owner.value) : "elsewhere";
    if (state === "running") return false;
    if (state === "exited") return true;
    return yield* lockStale(lock);
  }).pipe(Effect.orElseSucceed(() => false));

/**
 * Hold `<directory>/.server.lock` for the current scope. PGlite allows one process per database,
 * so no server opens storage without this lock, whatever port it listens on, and the desktop holds
 * it while it moves or resets the data. `owner.json` inside the lock records the holder's process,
 * host and, for a server, which passes it, the `port` it listens on. On Windows the holder listens
 * on a pipe for as long as it holds the lock, and `owner.json` names it: the pipe holds nothing
 * in the directory open, so the directory can still be renamed while the lock is held. `fs` is the
 * file system proper-lockfile uses, for a lock that moves with its directory.
 *
 * A lock another process holds fails with `directory-in-use` unless `lockAbandoned` says it was
 * abandoned, as by a crashed or killed server, decided once while holding
 * `.server.lock.takeover`, so two processes never both replace it. `lost` completes if another
 * process takes it over or it is removed, as proper-lockfile notices at its next refresh, so a
 * server stops instead of sharing its databases. `held` says at once whether the lock is still
 * this process's: not lost, and `owner.json` still holds the record this process wrote.
 */
export const lockDataDirectory = (
  directory: string,
  holder: { readonly port?: number; readonly fs?: LockOptions["fs"] } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, serviceLockFile);
    const ownerFile = path.join(file, "owner.json");
    const lost = yield* Deferred.make<void>();
    const inUse = () => new ServiceFailed({ reason: "directory-in-use", detail: directory });
    // proper-lockfile keeps one lock per path in a process. Key setup's lock already uses the
    // directory's, so these are keyed by their own files.
    const take = (lockfile: string, stale: number, onCompromised: () => void) =>
      Effect.tryPromise({
        try: () =>
          lock(lockfile, {
            realpath: false,
            lockfilePath: lockfile,
            retries: 0,
            stale,
            onCompromised,
            ...(holder.fs === undefined ? {} : { fs: holder.fs }),
          }),
        catch: inUse,
      });
    const attempt = take(file, serviceLockStale, () => {
      Deferred.doneUnsafe(lost, Effect.void);
    });
    const takeOver = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          take(`${file}.takeover`, 5_000, () => {}),
          (release) => Effect.tryPromise(() => release()).pipe(Effect.ignore),
        );
        if (!(yield* lockAbandoned(file))) return yield* inUse();
        // The abandoned lock is renamed aside in one step, then removed. Another starter's first
        // attempt removes a stale lock only while it is empty, so it cannot replace this one
        // halfway through its removal and lose its new lock to it.
        const aside = `${file}.abandoned`;
        yield* fs.remove(aside, { recursive: true, force: true }).pipe(Effect.mapError(inUse));
        yield* fs.rename(file, aside).pipe(Effect.mapError(inUse));
        yield* fs.remove(aside, { recursive: true }).pipe(Effect.ignore);
        return yield* attempt;
      }),
    );
    // Listening first, the pipe closes only after the release below: once `owner.json` is gone, a
    // lock without an owner counts as held, so no other process can take it over while it is
    // released. A holder without a pipe records none, and others fall back to the 30-second rule.
    const pipe =
      process.platform === "win32"
        ? yield* holdPipe.pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                "This process could not listen on its lock pipe, so another process takes over its data directory only 30 seconds after it stops refreshing its lock",
              ).pipe(Effect.annotateLogs({ detail: error.detail })),
            ),
            Effect.option,
          )
        : Option.none<string>();
    // The record this process writes. The release compares the whole record, so a host name
    // change cannot disown it.
    const owner: ServiceLockOwner = {
      ...(yield* ownProcess),
      ...(Option.isSome(pipe) ? { pipe: pipe.value } : {}),
      host: hostname(),
      ...(holder.port === undefined ? {} : { port: holder.port }),
    };
    // An owner that could not be written leaves the lock to proper-lockfile alone, which still
    // reports a takeover through `lost`.
    let written = false;
    const held = Effect.gen(function* () {
      if (yield* Deferred.isDone(lost)) return false;
      if (!written) return true;
      const current = yield* fs
        .readFileString(ownerFile)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ServiceLockOwner)), Effect.option);
      return Option.isSome(current) && sameOwner(current.value, owner);
    });
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* Effect.acquireRelease(
      attempt.pipe(Effect.catch(() => takeOver)),
      // The owner goes first, since only an empty lock directory can be released. A lock taken
      // over is no longer this process's, and neither is the owner inside it, so both are removed
      // only while the lock is still held.
      (release) =>
        Effect.gen(function* () {
          if (!(yield* held)) return;
          yield* fs.remove(ownerFile).pipe(Effect.ignore);
          yield* Effect.tryPromise(() => release()).pipe(Effect.ignore);
        }),
    );
    // Without an owner the lock still holds; only a crash then waits for it to go stale. Writing
    // the owner changes the lock's time, which proper-lockfile would take for a takeover, so the
    // time it recorded is restored. It reads Node's millisecond time, which rounds a time the
    // platform's stat truncates, as for a lock taken without setting its time, after another lock.
    yield* Effect.gen(function* () {
      const set = yield* Effect.tryPromise(() => stat(file)).pipe(Effect.map(({ mtime }) => mtime));
      yield* fs.writeFileString(ownerFile, yield* Schema.encodeEffect(ServiceLockOwner)(owner), {
        mode: 0o600,
      });
      written = true;
      yield* fs.utimes(file, set, set);
    }).pipe(Effect.ignore);
    return { lost: Deferred.await(lost), held };
  });

/**
 * Where the server `registration` names is now, in `directory`. On Linux and macOS its pid and the
 * start time it registered say. Windows records no start time; there the server is the process that
 * holds the directory's lock: it runs while the lock's owner names its pid and that owner's pipe
 * exists, and has exited once no process has its pid, its pipe is gone, or another process holds
 * the lock. Its state is not known while its pid runs and the lock names no owner, as while a
 * server stopping slowly has released its lock or one could not write its owner, nor when the owner
 * that names it recorded no pipe or its pipe cannot be read.
 */
export const registeredProcess = (directory: string, registration: ServiceRegistration) =>
  Effect.gen(function* () {
    const state = yield* recordedProcess(registration);
    if (state === "running" || state === "exited" || process.platform !== "win32") return state;
    const path = yield* Path.Path;
    const owner = yield* readLockOwner(path.join(directory, serviceLockFile));
    if (Option.isNone(owner))
      return (yield* processExists(registration.pid)) ? "unknown" : "exited";
    if (owner.value.pid !== registration.pid) return "exited";
    return yield* ownerProcess(owner.value);
  });

/**
 * Whether the server `registration` names may still run in `directory`, as `registeredProcess`
 * tells. Never for a process that has exited, also when its pid now names another program. One
 * this machine cannot check, as one registered on another boot or whose start time, this boot or
 * pipe cannot be read now, runs while it holds the directory's lock and refreshed it within
 * `serviceLockStale`, the rule the lock falls back to.
 */
export const registeredServerRuns = (directory: string, registration: ServiceRegistration) =>
  Effect.gen(function* () {
    const state = yield* registeredProcess(directory, registration);
    if (state === "running" || state === "exited") return state === "running";
    const path = yield* Path.Path;
    const lock = path.join(directory, serviceLockFile);
    const owner = yield* readLockOwner(lock);
    return (
      Option.isSome(owner) &&
      sameProcess(owner.value, registration) &&
      !(yield* lockStale(lock).pipe(Effect.orElseSucceed(() => true)))
    );
  });

/** Whether two registrations describe the same server process. */
export const sameRegistration = (left: ServiceRegistration, right: ServiceRegistration) =>
  left.id === right.id &&
  left.pid === right.pid &&
  left.url === right.url &&
  left.version === right.version;

/** The registered server, if any. A missing or unreadable file means none is registered. */
export const readRegistration = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs
      .readFileString(path.join(directory, serviceRegistrationFile))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RegistrationJson)), Effect.option);
  });

/**
 * The base64url HMAC-SHA256 of `challenge` keyed with a server's password: what a server answers on
 * its info route to prove it is the process a registration names.
 */
export const serviceProof = (password: string, challenge: string) =>
  Effect.promise(async () => {
    const encoder = new TextEncoder();
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(challenge));
    return Base64Url.encode(new Uint8Array(signature));
  });

/** A fresh nonce for one info request. */
export const serviceChallenge = Effect.sync(() =>
  Base64Url.encode(globalThis.crypto.getRandomValues(new Uint8Array(24))),
);

/**
 * Whether `info`, the answer to `challenge`, comes from the process `registration` names: it
 * reports that process and proves it holds the registration's password.
 */
export const answersAs = (
  registration: ServiceRegistration,
  info: ServiceInfo,
  challenge: string,
) =>
  Effect.gen(function* () {
    if (
      info.pid !== registration.pid ||
      info.id !== registration.id ||
      info.version !== registration.version ||
      info.proof === undefined
    )
      return false;
    return info.proof === (yield* serviceProof(registration.password, challenge));
  });

/**
 * Whether an Executor answers its session route at `url`, as every Executor 2 server does. Only a
 * refused connection or an answer that is not Executor's is a no: one that does not answer in
 * time may be an Executor that is busy.
 */
const executorAnswers = (url: string) =>
  HttpClient.get(`${url}/auth/session`).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(BrowserSession)),
    Effect.as(true),
    Effect.timeout("2 seconds"),
    Effect.catchTag("TimeoutError", () => Effect.succeed(true)),
    Effect.orElseSucceed(() => false),
    Effect.provide(NodeHttpClient.layerNodeHttp),
  );

/**
 * Fail with `directory-in-use` while an Executor from before the background service runs with this
 * data directory, as its `server.json` names it. It holds no lock, so only its record shows that.
 * Such a server wrote its record once it answered, so a record whose process runs while nothing
 * answers as Executor at its URL was left by one that was killed, and its pid now belongs to
 * another program: it is ignored, saying so on stderr, until a server replaces it.
 */
export const refuseEarlierServer = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, serviceRegistrationFile);
    const record = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(EarlierJson)), Effect.option);
    if (Option.isNone(record) || !(yield* processExists(record.value.pid))) return;
    const { pid, url } = record.value;
    // Only a loopback record can be checked from here; one naming a browser origin may sit behind
    // a proxy this host cannot reach, so it counts as running.
    const { hostname: host } = new URL(url);
    if ((host === "127.0.0.1" || host === "localhost") && !(yield* executorAnswers(url)))
      return yield* Console.error(
        `Ignoring ${file}: it names process ${pid}, but no Executor answers at ${url}.`,
      );
    return yield* new ServiceFailed({
      reason: "directory-in-use",
      detail: directory,
      url,
      earlier: pid,
    });
  });

/** Replace the registration atomically with mode 0600. */
export const writeRegistration = (
  platform: string,
  directory: string,
  registration: ServiceRegistration,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const encoded = yield* Schema.encodeEffect(RegistrationJson)(registration);
    yield* writeAtomically(
      platform,
      directory,
      path.join(directory, serviceRegistrationFile),
      encoded,
    );
  });

/** Remove the registration only while it still names `registration`, never a successor's. */
export const removeRegistration = (directory: string, registration: ServiceRegistration) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const current = yield* readRegistration(directory);
    if (Option.isNone(current) || !sameRegistration(current.value, registration)) return;
    yield* fs.remove(path.join(directory, serviceRegistrationFile), { force: true });
  });

/** The background service settings; none saved means defaults. */
export const readSettings = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, serviceSettingsFile);
    const text = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(text)) return {} satisfies ServiceSettings;
    return yield* Schema.decodeUnknownEffect(SettingsJson)(text.value).pipe(
      Effect.mapError(
        () =>
          new ServiceSettingInvalid({
            message: `${file} is not valid. Fix it or remove it, then try again.`,
          }),
      ),
    );
  });

/** Save the settings atomically with mode 0600, creating the data directory if needed. */
export const writeSettings = (platform: string, directory: string, settings: ServiceSettings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const encoded = yield* Schema.encodeEffect(SettingsJson)(settings);
    yield* writeAtomically(platform, directory, path.join(directory, serviceSettingsFile), encoded);
  });
