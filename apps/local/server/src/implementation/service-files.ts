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

export const serviceVersion = Config.String("EXECUTOR_BUILD_VERSION").pipe(
  Config.withDefault("0.0.0-dev"),
);

export const serviceDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(yield* dataDirectoryConfig);
});

const RegistrationJson = Schema.fromJsonString(ServiceRegistration);
const EarlierJson = Schema.fromJsonString(EarlierServerRecord);
const SettingsJson = Schema.fromJsonString(ServiceSettings);

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

export const serviceLockStale = 30_000;
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

const sameProcess = (left: RecordedProcess, right: RecordedProcess) =>
  left.pid === right.pid && left.started === right.started && left.boot === right.boot;

const sameOwner = (left: ServiceLockOwner, right: ServiceLockOwner) =>
  sameProcess(left, right) &&
  left.pipe === right.pipe &&
  left.host === right.host &&
  left.port === right.port;

const ownerProcess = (owner: ServiceLockOwner) =>
  owner.pipe === undefined
    ? recordedProcess(owner)
    : process.platform === "win32" && owner.host === hostname()
      ? pipeHolder(owner.pipe)
      : Effect.succeed<ProcessState>("elsewhere");

const readLockOwner = (lock: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs
      .readFileString(path.join(lock, "owner.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ServiceLockOwner)), Effect.option);
  });

const lockStale = (lock: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const refreshed = Option.getOrUndefined((yield* fs.stat(lock)).mtime)?.getTime() ?? 0;
    return refreshed < (yield* Clock.currentTimeMillis) - serviceLockStale;
  });

const lockAbandoned = (lock: string) =>
  Effect.gen(function* () {
    const owner = yield* readLockOwner(lock);
    const state = Option.isSome(owner) ? yield* ownerProcess(owner.value) : "elsewhere";
    if (state === "running") return false;
    if (state === "exited") return true;
    return yield* lockStale(lock);
  }).pipe(Effect.orElseSucceed(() => false));

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
        const aside = `${file}.abandoned`;
        yield* fs.remove(aside, { recursive: true, force: true }).pipe(Effect.mapError(inUse));
        yield* fs.rename(file, aside).pipe(Effect.mapError(inUse));
        yield* fs.remove(aside, { recursive: true }).pipe(Effect.ignore);
        return yield* attempt;
      }),
    );
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
    const owner: ServiceLockOwner = {
      ...(yield* ownProcess),
      ...(Option.isSome(pipe) ? { pipe: pipe.value } : {}),
      host: hostname(),
      ...(holder.port === undefined ? {} : { port: holder.port }),
    };
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
    yield* Effect.acquireRelease(attempt.pipe(Effect.catch(() => takeOver)), (release) =>
      Effect.gen(function* () {
        if (!(yield* held)) return;
        yield* fs.remove(ownerFile).pipe(Effect.ignore);
        yield* Effect.tryPromise(() => release()).pipe(Effect.ignore);
      }),
    );
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

export const sameRegistration = (left: ServiceRegistration, right: ServiceRegistration) =>
  left.id === right.id &&
  left.pid === right.pid &&
  left.url === right.url &&
  left.version === right.version;

export const readRegistration = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs
      .readFileString(path.join(directory, serviceRegistrationFile))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RegistrationJson)), Effect.option);
  });

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

export const serviceChallenge = Effect.sync(() =>
  Base64Url.encode(globalThis.crypto.getRandomValues(new Uint8Array(24))),
);

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

const executorAnswers = (url: string) =>
  HttpClient.get(`${url}/auth/session`).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(BrowserSession)),
    Effect.as(true),
    Effect.timeout("2 seconds"),
    Effect.catchTag("TimeoutError", () => Effect.succeed(true)),
    Effect.orElseSucceed(() => false),
    Effect.provide(NodeHttpClient.layerNodeHttp),
  );

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

export const removeRegistration = (directory: string, registration: ServiceRegistration) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const current = yield* readRegistration(directory);
    if (Option.isNone(current) || !sameRegistration(current.value, registration)) return;
    yield* fs.remove(path.join(directory, serviceRegistrationFile), { force: true });
  });

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

export const writeSettings = (platform: string, directory: string, settings: ServiceSettings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const encoded = yield* Schema.encodeEffect(SettingsJson)(settings);
    yield* writeAtomically(platform, directory, path.join(directory, serviceSettingsFile), encoded);
  });
