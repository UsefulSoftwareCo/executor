import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { Config, Effect, FileSystem, Path, Ref, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { testCredential } from "../support/os-credential.ts";
import { freePort } from "../support/ports.ts";
import { localNpmRegistry } from "../support/npm-registry.ts";
import { scenarios } from "../test-plan.ts";

const Record = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isUUID()),
  state: Schema.Literals(["pending", "ready", "file"]),
});
const KeyFile = Schema.Struct({ apiKey: Schema.String, encryptionKey: Schema.String });
const notice = "OS credential store not found; keys saved to ";
const deniedMessage = "Access to the OS credential store was denied";
const chosenNotice = "EXECUTOR_KEY_STORAGE=file; keys saved to ";
const optIn = "set EXECUTOR_KEY_STORAGE=file";
const leakedHex = "ab".repeat(32);

/**
 * Write a stand-in for @napi-rs/keyring and return the node arguments that load it.
 * The child resolves the stand-in only when EXECUTOR_E2E_STAND_IN is set, so other
 * starts keep the real module. Errors copy the package's keyring-core text:
 * - absent: the constructor throws, as Linux does without D-Bus or a Secret Service.
 * - denied: reads reject, as a cancelled macOS Keychain prompt does.
 * - denied-noisy: reads reject with a control character and a long hex run, which the
 *   message must strip and redact.
 * - dismissed: reads find nothing and the write rejects, as a dismissed Secret Service
 *   unlock prompt does.
 * - no-logon-session: reads reject with Windows ERROR_NO_SUCH_LOGON_SESSION.
 * - granted: a working store kept in EXECUTOR_E2E_STAND_IN_FILE.
 * The real store is never touched.
 */
const standInKeyring = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(root, "stand-in-keyring.mjs"),
      [
        'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
        "const mode = process.env.EXECUTOR_E2E_STAND_IN;",
        "const file = process.env.EXECUTOR_E2E_STAND_IN_FILE;",
        "const reject = (message) => Promise.reject(new Error(message));",
        'const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});',
        "export class AsyncEntry {",
        "  constructor(service, username) {",
        '    if (mode === "absent")',
        '      throw new Error("Platform failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files");',
        "    this.username = username;",
        "  }",
        "  getPassword() {",
        '    if (mode === "denied") return reject("Platform failure: User canceled the operation.");',
        '    if (mode === "denied-noisy")',
        `      return reject("Couldn't access platform storage: locked\\u0007${leakedHex}");`,
        '    if (mode === "no-logon-session")',
        '      return reject("Couldn\'t access platform storage: Windows ERROR_NO_SUCH_LOGON_SESSION");',
        '    if (mode === "granted") return Promise.resolve(read()[this.username]);',
        "    return Promise.resolve(undefined);",
        "  }",
        "  setPassword(password) {",
        '    if (mode === "granted") {',
        "      writeFileSync(file, JSON.stringify({ ...read(), [this.username]: password }));",
        "      return Promise.resolve();",
        "    }",
        '    return reject("Couldn\'t access platform storage: Secret Service: unlock prompt was dismissed");',
        "  }",
        "}",
      ].join("\n"),
    );
    yield* fs.writeFileString(
      path.join(root, "hooks.mjs"),
      [
        'const standIn = new URL("./stand-in-keyring.mjs", import.meta.url).href;',
        "export async function resolve(specifier, context, next) {",
        '  if (specifier === "@napi-rs/keyring" && process.env.EXECUTOR_E2E_STAND_IN)',
        "    return { url: standIn, shortCircuit: true };",
        "  return next(specifier, context);",
        "}",
      ].join("\n"),
    );
    yield* fs.writeFileString(
      path.join(root, "register.mjs"),
      'import { register } from "node:module";\nregister("./hooks.mjs", import.meta.url);\n',
    );
    // --import takes a module specifier; a bare Windows path would parse as a URL scheme.
    return ["--import", (yield* path.toFileUrl(path.join(root, "register.mjs"))).href];
  });

/** Drive the packaged CLI against one data directory with an explicit environment. */
const packagedCli = (options: {
  readonly keys: ReadonlyArray<string>;
  readonly nodeArgs: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const http = yield* HttpClient.HttpClient;
    const entry = path.resolve(yield* Config.String("EXECUTOR_E2E_LOCAL_ENTRY"));
    // Startup deploys the bundled Executor app, which pins this checkout's apps release.
    const registry = yield* localNpmRegistry;
    const environment = (
      directory: string,
      port: number,
      extra: Readonly<Record<string, string>>,
    ) => ({
      ...Object.fromEntries(
        options.keys.flatMap((key) => {
          const value = process.env[key];
          return value === undefined ? [] : [[key, value] as const];
        }),
      ),
      // Release scenarios never send product analytics, even from a build with a baked key.
      DO_NOT_TRACK: "1",
      EXECUTOR_DATA_DIR: directory,
      EXECUTOR_PORT: String(port),
      EXECUTOR_ENVIRONMENT: "e2e",
      EXECUTOR_NPM_REGISTRY: registry.url,
      ...extra,
    });
    const command = (
      directory: string,
      port: number,
      extra: Readonly<Record<string, string>>,
      subcommand = "serve",
    ) =>
      ChildProcess.make("node", [...options.nodeArgs, entry, subcommand], {
        cwd: path.dirname(directory),
        env: environment(directory, port, extra),
        extendEnv: false,
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: 5_000,
      });
    const readRecord = (directory: string) =>
      fs
        .readFileString(path.join(directory, "installation.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Record))));

    /** Start until ready, prove the bearer key works, then stop. Returns output seen so far. */
    const start = (
      directory: string,
      options: {
        readonly apiKey?: () => Effect.Effect<string, unknown>;
        readonly env?: Readonly<Record<string, string>>;
        /** A replaced key that must now be refused. */
        readonly previousKey?: string;
      } = {},
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const port = yield* freePort;
          const child = yield* processes.spawn(command(directory, port, options.env ?? {}));
          const collect = (stream: typeof child.stdout) =>
            Effect.gen(function* () {
              const seen = yield* Ref.make("");
              yield* stream.pipe(
                Stream.decodeText,
                Stream.runForEach((text) => Ref.update(seen, (before) => before + text)),
                Effect.forkScoped,
              );
              return seen;
            });
          const stdout = yield* collect(child.stdout);
          const stderr = yield* collect(child.stderr);
          const origin = `http://127.0.0.1:${port}`;
          const ready = http.get(`${origin}/auth/session`).pipe(
            Effect.flatMap((response) => response.json),
            Effect.timeout(2_000),
            Effect.retry({ schedule: Schedule.spaced(200), times: 200 }),
          );
          const exited = child.exitCode.pipe(
            Effect.flatMap(() => Effect.fail(new Error("Packaged CLI exited before readiness"))),
          );
          expect(yield* Effect.raceFirst(ready, exited)).toEqual({ authenticated: false });
          if (options.apiKey !== undefined) {
            const key = yield* options.apiKey();
            const authorized = yield* http.execute(
              HttpClientRequest.get(`${origin}/openapi.json`).pipe(
                HttpClientRequest.bearerToken(key),
              ),
            );
            expect(authorized.status).toBe(200);
            const other = yield* http.execute(
              HttpClientRequest.get(`${origin}/openapi.json`).pipe(
                HttpClientRequest.bearerToken("x".repeat(64)),
              ),
            );
            expect(other.status).toBe(401);
          }
          if (options.previousKey !== undefined) {
            const previous = yield* http.execute(
              HttpClientRequest.get(`${origin}/openapi.json`).pipe(
                HttpClientRequest.bearerToken(options.previousKey),
              ),
            );
            expect(previous.status).toBe(401);
          }
          return { stdout: yield* Ref.get(stdout), stderr: yield* Ref.get(stderr) };
        }),
      );

    /** Run to exit and return its exit code and complete stderr. */
    const refuse = (directory: string, env: Readonly<Record<string, string>> = {}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const port = yield* freePort;
          const child = yield* processes.spawn(command(directory, port, env));
          yield* child.stdout.pipe(Stream.runDrain, Effect.forkScoped);
          const [code, message] = yield* Effect.all(
            [child.exitCode, child.stderr.pipe(Stream.decodeText, Stream.mkString)],
            { concurrency: 2 },
          );
          return { code: Number(code), message };
        }),
      );
    /** Run `executor rotate-key` to exit and return its exit code and output. */
    const rotate = (directory: string, env: Readonly<Record<string, string>> = {}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const port = yield* freePort;
          const child = yield* processes.spawn(command(directory, port, env, "rotate-key"));
          const [code, stdout, stderr] = yield* Effect.all(
            [
              child.exitCode,
              child.stdout.pipe(Stream.decodeText, Stream.mkString),
              child.stderr.pipe(Stream.decodeText, Stream.mkString),
            ],
            { concurrency: 3 },
          );
          return { code: Number(code), stdout, stderr };
        }),
      );
    return { start, refuse, rotate, readRecord };
  });

it.live(scenarios.localBootstrap.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-keyring-e2e-" });
      const cli = yield* packagedCli({
        keys: [
          "PATH",
          "HOME",
          "USERPROFILE",
          "SystemRoot",
          "APPDATA",
          "LOCALAPPDATA",
          "DBUS_SESSION_BUS_ADDRESS",
          "XDG_RUNTIME_DIR",
        ],
        nodeArgs: [],
      });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (yield* fs.exists(path.join(directory, "installation.json"))) {
            const record = yield* cli.readRecord(directory);
            const credential = yield* testCredential(record.id);
            if ((yield* credential.fingerprint) !== undefined) yield* credential.remove;
          }
        }).pipe(Effect.orDie),
      );
      const { stderr } = yield* cli.start(directory);
      expect(stderr).not.toContain(notice);
      expect(yield* fs.exists(path.join(directory, "keys.json"))).toBe(false);
      const installation = yield* cli.readRecord(directory);
      expect(installation.state).toBe("ready");
      const credential = yield* testCredential(installation.id);
      const first = yield* credential.fingerprint;
      expect(typeof first === "string" && first.length === 64).toBe(true);
      yield* cli.start(directory);
      expect((yield* cli.readRecord(directory)).id).toBe(installation.id);
      expect((yield* credential.fingerprint) === first).toBe(true);

      // Delete only this test's generated OS entry, then check refusal through the actual CLI.
      yield* credential.remove;
      const missing = yield* cli.refuse(directory);
      expect(missing.code).toBe(1);
      expect(missing.message).toContain("OS credential is missing");
      expect((yield* cli.readRecord(directory)).id).toBe(installation.id);
      expect((yield* credential.fingerprint) === undefined).toBe(true);
      expect(yield* fs.exists(path.join(directory, "keys.json"))).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live(scenarios.localBootstrapKeyFile.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-key-file-e2e-" });
      // CI sets "absent" on Linux outside any D-Bus session, where Secret Service
      // genuinely cannot be reached. Elsewhere the store is present, so the child
      // loads a stand-in keyring module whose constructor fails as an absent store's does.
      const store = yield* Config.Literals(
        ["present", "absent"],
        "EXECUTOR_E2E_CREDENTIAL_STORE",
      ).pipe(Config.withDefault("present"));
      const nodeArgs = yield* standInKeyring(root);
      const absent: Record<string, string> =
        store === "present" ? { EXECUTOR_E2E_STAND_IN: "absent" } : {};
      // No D-Bus variables reach the child, so Linux cannot find a Secret Service.
      const cli = yield* packagedCli({
        keys: ["PATH", "HOME", "USERPROFILE", "SystemRoot", "APPDATA", "LOCALAPPDATA"],
        nodeArgs,
      });
      const fresh = (name: string) =>
        Effect.gen(function* () {
          const directory = path.join(root, name);
          yield* fs.makeDirectory(directory);
          return directory;
        });

      // First start without a store saves the keys to a private file and says so on stderr.
      // Executor creates this directory itself, so its mode is Executor's choice.
      const directory = path.join(root, "first-start");
      const keyFile = path.join(directory, "keys.json");
      const readKeys = fs
        .readFileString(keyFile)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(KeyFile))));
      const first = yield* cli.start(directory, {
        apiKey: () => readKeys.pipe(Effect.map((keys) => keys.apiKey)),
        env: absent,
      });
      expect(first.stderr).toContain(`${notice}${keyFile}`);
      // stdout is the desktop readiness protocol and must never carry the notice.
      expect(first.stdout).not.toContain(notice);
      const installation = yield* cli.readRecord(directory);
      expect(installation.state).toBe("file");
      const keys = yield* readKeys;
      expect(keys.apiKey.length).toBeGreaterThanOrEqual(32);
      expect(keys.encryptionKey).toMatch(/^[a-f0-9]{64}$/);
      if (process.platform !== "win32") {
        expect((yield* fs.stat(keyFile)).mode & 0o777).toBe(0o600);
        expect((yield* fs.stat(directory)).mode & 0o077).toBe(0);
      }
      const fingerprint = createHash("sha256")
        .update(yield* fs.readFileString(keyFile))
        .digest("hex");

      // Restart reuses the same file and record without a new notice.
      const restart = yield* cli.start(directory, {
        apiKey: () => Effect.succeed(keys.apiKey),
        env: absent,
      });
      expect(restart.stderr).not.toContain(notice);
      expect(yield* cli.readRecord(directory)).toEqual(installation);
      expect(
        createHash("sha256")
          .update(yield* fs.readFileString(keyFile))
          .digest("hex"),
      ).toBe(fingerprint);

      // Supplied keys cannot silently move a key-file directory to external keys.
      const supplied = yield* cli.refuse(directory, {
        ...absent,
        EXECUTOR_API_KEY: keys.apiKey,
        EXECUTOR_ENCRYPTION_KEY: keys.encryptionKey,
      });
      expect(supplied.code).toBe(1);
      expect(supplied.message).toContain("This directory uses its key file");
      expect(yield* cli.readRecord(directory)).toEqual(installation);

      // Losing the key file stops startup instead of generating replacements.
      yield* fs.remove(keyFile);
      const lost = yield* cli.refuse(directory, absent);
      expect(lost.code).toBe(1);
      expect(lost.message).toContain(`key file ${keyFile} is missing or invalid`);
      expect(yield* fs.exists(keyFile)).toBe(false);
      expect(yield* cli.readRecord(directory)).toEqual(installation);

      // A pending record from a first start without a store also falls back.
      const pending = yield* fresh("pending");
      const pendingRecord = { version: 1, id: crypto.randomUUID(), state: "pending" } as const;
      yield* fs.writeFileString(
        path.join(pending, "installation.json"),
        JSON.stringify(pendingRecord),
      );
      const pendingStart = yield* cli.start(pending, { env: absent });
      expect(pendingStart.stderr).toContain(`${notice}${path.join(pending, "keys.json")}`);
      expect(yield* cli.readRecord(pending)).toEqual({ ...pendingRecord, state: "file" });

      // A first start interrupted after saving its key file finishes with those keys.
      const interrupted = yield* fresh("interrupted");
      const interruptedRecord = { version: 1, id: crypto.randomUUID(), state: "pending" } as const;
      yield* fs.writeFileString(
        path.join(interrupted, "installation.json"),
        JSON.stringify(interruptedRecord),
      );
      yield* fs.writeFileString(path.join(interrupted, "keys.json"), JSON.stringify(keys));
      const resumed = yield* cli.start(interrupted, {
        apiKey: () => Effect.succeed(keys.apiKey),
        env: absent,
      });
      expect(resumed.stderr).not.toContain(notice);
      expect(yield* cli.readRecord(interrupted)).toEqual({ ...interruptedRecord, state: "file" });
      expect(yield* fs.readFileString(path.join(interrupted, "keys.json"))).toBe(
        JSON.stringify(keys),
      );

      // A directory that already keeps its keys in the OS store never falls back.
      const keyring = yield* fresh("keyring");
      const readyRecord = { version: 1, id: crypto.randomUUID(), state: "ready" } as const;
      yield* fs.writeFileString(
        path.join(keyring, "installation.json"),
        JSON.stringify(readyRecord),
      );
      const unavailable = yield* cli.refuse(keyring, absent);
      expect(unavailable.code).toBe(1);
      expect(unavailable.message).toContain("OS credential store could not be found");
      expect(yield* fs.exists(path.join(keyring, "keys.json"))).toBe(false);
      expect(yield* cli.readRecord(keyring)).toEqual(readyRecord);

      // Existing data without a record still refuses to create keys.
      const orphaned = yield* fresh("orphaned");
      yield* fs.makeDirectory(path.join(orphaned, "executor.pglite"));
      const unrecorded = yield* cli.refuse(orphaned, absent);
      expect(unrecorded.code).toBe(1);
      expect(unrecorded.message).toContain("Existing Executor data has no installation record");
      expect(yield* fs.exists(path.join(orphaned, "keys.json"))).toBe(false);
      expect(yield* fs.exists(path.join(orphaned, "installation.json"))).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live(scenarios.localBootstrapDenied.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-denied-e2e-" });
      const cli = yield* packagedCli({
        keys: ["PATH", "HOME", "USERPROFILE", "SystemRoot", "APPDATA", "LOCALAPPDATA"],
        nodeArgs: yield* standInKeyring(root),
      });
      const storeFile = path.join(root, "stand-in-store.json");
      const as = (mode: string) => ({
        EXECUTOR_E2E_STAND_IN: mode,
        EXECUTOR_E2E_STAND_IN_FILE: storeFile,
      });
      const fresh = (name: string) =>
        Effect.gen(function* () {
          const directory = path.join(root, name);
          yield* fs.makeDirectory(directory);
          return directory;
        });

      // A cancelled prompt on the first read stops startup and saves no keys anywhere.
      const directory = path.join(root, "first-start");
      const keyFile = path.join(directory, "keys.json");
      const cancelled = yield* cli.refuse(directory, as("denied"));
      expect(cancelled.code).toBe(1);
      expect(cancelled.message).toContain(deniedMessage);
      expect(cancelled.message).toContain("Start Executor again to be asked again");
      // The platform text explains the failure; sessions without prompts get an
      // unlock command, and a new directory gets the key file opt-in.
      expect(cancelled.message).toContain("(Platform failure: User canceled the operation.)");
      if (process.platform === "linux")
        expect(cancelled.message).toContain("`gnome-keyring-daemon --unlock`");
      if (process.platform === "darwin")
        expect(cancelled.message).toContain("`security unlock-keychain`");
      expect(cancelled.message).toContain(optIn);
      expect(cancelled.message).not.toContain(notice);
      expect(yield* fs.exists(keyFile)).toBe(false);
      const pending = yield* cli.readRecord(directory);
      expect(pending.state).toBe("pending");

      // A dismissed prompt when saving the new credential also stops without a key file.
      const dismissed = yield* cli.refuse(directory, as("dismissed"));
      expect(dismissed.code).toBe(1);
      expect(dismissed.message).toContain(deniedMessage);
      expect(yield* fs.exists(keyFile)).toBe(false);
      expect(yield* cli.readRecord(directory)).toEqual(pending);

      // Granting access on a later start keeps the keys in the store.
      const granted = yield* cli.start(directory, {
        env: as("granted"),
        apiKey: () =>
          fs.readFileString(storeFile).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
              ),
            ),
            Effect.flatMap((saved) =>
              Schema.decodeUnknownEffect(Schema.fromJsonString(KeyFile))(saved[pending.id]),
            ),
            Effect.map((keys) => keys.apiKey),
          ),
      });
      expect(granted.stderr).not.toContain(notice);
      expect(yield* fs.exists(keyFile)).toBe(false);
      expect(yield* cli.readRecord(directory)).toEqual({ ...pending, state: "ready" });

      // Once ready, denied access still never falls back.
      const later = yield* cli.refuse(directory, as("denied"));
      expect(later.code).toBe(1);
      expect(later.message).toContain(deniedMessage);
      // A ready directory cannot switch, so the opt-in is not offered.
      expect(later.message).not.toContain(optIn);
      expect(yield* fs.exists(keyFile)).toBe(false);

      // Platform text is sanitized before display.
      const noisy = yield* cli.refuse(directory, as("denied-noisy"));
      expect(noisy.code).toBe(1);
      expect(noisy.message).toContain("(Couldn't access platform storage: locked [redacted])");
      expect(noisy.message).not.toContain(leakedHex);
      expect(noisy.message).not.toContain("\u0007");
      expect((yield* cli.readRecord(directory)).state).toBe("ready");

      // A pending record left by a denied start still falls back if the store is absent.
      const retried = yield* fresh("denied-then-absent");
      const denied = yield* cli.refuse(retried, as("denied"));
      expect(denied.code).toBe(1);
      const retriedRecord = yield* cli.readRecord(retried);
      const absent = yield* cli.start(retried, { env: as("absent") });
      expect(absent.stderr).toContain(`${notice}${path.join(retried, "keys.json")}`);
      expect(yield* cli.readRecord(retried)).toEqual({ ...retriedRecord, state: "file" });

      // Windows reports a logon session without a credential vault as absent; elsewhere
      // that text is not a recognized absence and counts as denied.
      const session = yield* fresh("no-logon-session");
      if (process.platform === "win32") {
        const saved = yield* cli.start(session, { env: as("no-logon-session") });
        expect(saved.stderr).toContain(`${notice}${path.join(session, "keys.json")}`);
        expect((yield* cli.readRecord(session)).state).toBe("file");
      } else {
        const refused = yield* cli.refuse(session, as("no-logon-session"));
        expect(refused.code).toBe(1);
        expect(refused.message).toContain(deniedMessage);
        expect(yield* fs.exists(path.join(session, "keys.json"))).toBe(false);
        expect((yield* cli.readRecord(session)).state).toBe("pending");
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live(scenarios.localBootstrapKeyStorage.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-key-storage-e2e-" });
      const cli = yield* packagedCli({
        keys: ["PATH", "HOME", "USERPROFILE", "SystemRoot", "APPDATA", "LOCALAPPDATA"],
        nodeArgs: yield* standInKeyring(root),
      });
      const storeFile = path.join(root, "stand-in-store.json");
      const as = (mode: string, storage?: string) => ({
        EXECUTOR_E2E_STAND_IN: mode,
        EXECUTOR_E2E_STAND_IN_FILE: storeFile,
        ...(storage === undefined ? {} : { EXECUTOR_KEY_STORAGE: storage }),
      });
      const readKeys = (directory: string) =>
        fs
          .readFileString(path.join(directory, "keys.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(KeyFile))));
      const fingerprint = (file: string) =>
        fs
          .readFileString(file)
          .pipe(Effect.map((text) => createHash("sha256").update(text).digest("hex")));

      // A first start with a working store still uses keys.json when asked, and
      // never writes the store.
      const chosen = path.join(root, "chosen");
      const chosenKeyFile = path.join(chosen, "keys.json");
      const first = yield* cli.start(chosen, {
        env: as("granted", "file"),
        apiKey: () => readKeys(chosen).pipe(Effect.map((keys) => keys.apiKey)),
      });
      expect(first.stderr).toContain(`${chosenNotice}${chosenKeyFile}`);
      expect(first.stderr).not.toContain(notice);
      expect(first.stdout).not.toContain(chosenNotice);
      const chosenRecord = yield* cli.readRecord(chosen);
      expect(chosenRecord.state).toBe("file");
      if (process.platform !== "win32") {
        expect((yield* fs.stat(chosenKeyFile)).mode & 0o777).toBe(0o600);
        expect((yield* fs.stat(chosen)).mode & 0o077).toBe(0);
      }
      expect(yield* fs.exists(storeFile)).toBe(false);
      const keys = yield* readKeys(chosen);
      const chosenFingerprint = yield* fingerprint(chosenKeyFile);

      // On a file directory the opt-in is a no-op, and later starts need no opt-in.
      for (const env of [as("granted", "file"), as("granted")]) {
        const again = yield* cli.start(chosen, { env, apiKey: () => Effect.succeed(keys.apiKey) });
        expect(again.stderr).not.toContain(chosenNotice);
        expect(yield* cli.readRecord(chosen)).toEqual(chosenRecord);
        expect(yield* fingerprint(chosenKeyFile)).toBe(chosenFingerprint);
      }
      expect(yield* fs.exists(storeFile)).toBe(false);

      // Requiring the OS store on a file directory fails without changes.
      const toStore = yield* cli.refuse(chosen, as("granted", "os"));
      expect(toStore.code).toBe(1);
      expect(toStore.message).toContain(
        "This directory keeps its keys in keys.json, so EXECUTOR_KEY_STORAGE=os cannot apply",
      );
      expect(yield* cli.readRecord(chosen)).toEqual(chosenRecord);
      expect(yield* fingerprint(chosenKeyFile)).toBe(chosenFingerprint);
      expect(yield* fs.exists(storeFile)).toBe(false);

      // A pending directory left by denied access can opt in on its next start.
      const pending = path.join(root, "pending");
      const denied = yield* cli.refuse(pending, as("denied"));
      expect(denied.code).toBe(1);
      expect(denied.message).toContain(optIn);
      const pendingRecord = yield* cli.readRecord(pending);
      expect(pendingRecord.state).toBe("pending");
      const optedIn = yield* cli.start(pending, {
        env: as("denied", "file"),
        apiKey: () => readKeys(pending).pipe(Effect.map((saved) => saved.apiKey)),
      });
      expect(optedIn.stderr).toContain(`${chosenNotice}${path.join(pending, "keys.json")}`);
      expect(yield* cli.readRecord(pending)).toEqual({ ...pendingRecord, state: "file" });
      expect(yield* fs.exists(storeFile)).toBe(false);

      // A directory that keeps its keys in the OS store is never switched.
      const ready = path.join(root, "ready");
      yield* cli.start(ready, { env: as("granted") });
      const readyRecord = yield* cli.readRecord(ready);
      expect(readyRecord.state).toBe("ready");
      const storeFingerprint = yield* fingerprint(storeFile);
      const switched = yield* cli.refuse(ready, as("granted", "file"));
      expect(switched.code).toBe(1);
      expect(switched.message).toContain(
        "This directory keeps its keys in the OS credential store, so EXECUTOR_KEY_STORAGE=file cannot apply",
      );
      expect(switched.message).toContain("Nothing was changed.");
      expect(switched.message).not.toContain(chosenNotice);
      expect(yield* fs.exists(path.join(ready, "keys.json"))).toBe(false);
      expect(yield* cli.readRecord(ready)).toEqual(readyRecord);
      expect(yield* fingerprint(storeFile)).toBe(storeFingerprint);
      // Requiring the store it already uses is a no-op.
      yield* cli.start(ready, { env: as("granted", "os") });
      expect(yield* cli.readRecord(ready)).toEqual(readyRecord);
      expect(yield* fingerprint(storeFile)).toBe(storeFingerprint);

      // Requiring the store disables the automatic fallback on a first start.
      const required = path.join(root, "required");
      const absent = yield* cli.refuse(required, as("absent", "os"));
      expect(absent.code).toBe(1);
      expect(absent.message).toContain("EXECUTOR_KEY_STORAGE=os requires it");
      expect(absent.message).toContain(optIn);
      expect(absent.message).not.toContain(notice);
      expect(yield* fs.exists(path.join(required, "keys.json"))).toBe(false);
      expect((yield* cli.readRecord(required)).state).toBe("pending");

      // Supplied keys are never stored, so a storage choice cannot apply to them.
      const supplied = path.join(root, "supplied");
      const withKeys = yield* cli.refuse(supplied, {
        ...as("granted", "file"),
        EXECUTOR_API_KEY: keys.apiKey,
        EXECUTOR_ENCRYPTION_KEY: keys.encryptionKey,
      });
      expect(withKeys.code).toBe(1);
      expect(withKeys.message).toContain("EXECUTOR_KEY_STORAGE cannot apply");
      expect(yield* fs.exists(path.join(supplied, "keys.json"))).toBe(false);

      // An unknown value lists the valid ones and creates nothing.
      const invalid = path.join(root, "invalid");
      const unknown = yield* cli.refuse(invalid, as("granted", "keyring"));
      expect(unknown.code).toBe(1);
      expect(unknown.message).toContain('EXECUTOR_KEY_STORAGE must be "file"');
      expect(unknown.message).toContain('or "os"');
      expect(yield* fs.exists(invalid)).toBe(false);
      expect(yield* fingerprint(storeFile)).toBe(storeFingerprint);
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.live(scenarios.localBootstrapRotation.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-rotation-e2e-" });
      const cli = yield* packagedCli({
        keys: ["PATH", "HOME", "USERPROFILE", "SystemRoot", "APPDATA", "LOCALAPPDATA"],
        nodeArgs: yield* standInKeyring(root),
      });
      const storeFile = path.join(root, "stand-in-store.json");
      const as = (mode: string, storage?: string) => ({
        EXECUTOR_E2E_STAND_IN: mode,
        EXECUTOR_E2E_STAND_IN_FILE: storeFile,
        ...(storage === undefined ? {} : { EXECUTOR_KEY_STORAGE: storage }),
      });
      const rotated = "Rotated the local API key.";
      const unchanged = "The API key was not changed.";
      const readKeys = (directory: string) =>
        fs
          .readFileString(path.join(directory, "keys.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(KeyFile))));
      const storedKeys = (id: string) =>
        fs.readFileString(storeFile).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
            ),
          ),
          Effect.flatMap((saved) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(KeyFile))(saved[id]),
          ),
        );
      /** The server accepts the new key and refuses the one it replaced. */
      const accepts = (
        directory: string,
        env: Readonly<Record<string, string>>,
        key: string,
        previousKey: string,
      ) => cli.start(directory, { env, apiKey: () => Effect.succeed(key), previousKey });

      // A directory with no saved keys has nothing to rotate and is left untouched.
      const empty = path.join(root, "empty");
      const nothing = yield* cli.rotate(empty, as("granted"));
      expect(nothing.code).toBe(1);
      expect(nothing.stderr).toContain("This directory has no saved keys.");
      expect(nothing.stderr).toContain(unchanged);
      expect(yield* fs.exists(path.join(empty, "installation.json"))).toBe(false);

      // keys.json: the API key is replaced in place, the encryption key and record are kept.
      const file = path.join(root, "file");
      const keyFile = path.join(file, "keys.json");
      yield* cli.start(file, { env: as("granted", "file") });
      const fileRecord = yield* cli.readRecord(file);
      const before = yield* readKeys(file);
      const fileRotation = yield* cli.rotate(file, as("granted"));
      expect(fileRotation.code).toBe(0);
      expect(fileRotation.stdout).toContain(rotated);
      const after = yield* readKeys(file);
      expect(after.apiKey).not.toBe(before.apiKey);
      expect(after.apiKey).toMatch(/^[a-f0-9]{64}$/);
      expect(after.encryptionKey).toBe(before.encryptionKey);
      expect(`${fileRotation.stdout}${fileRotation.stderr}`).not.toContain(after.apiKey);
      expect(yield* cli.readRecord(file)).toEqual(fileRecord);
      if (process.platform !== "win32") expect((yield* fs.stat(keyFile)).mode & 0o777).toBe(0o600);
      expect(yield* fs.exists(storeFile)).toBe(false);
      yield* accepts(file, as("granted"), after.apiKey, before.apiKey);

      // OS credential store: the same credential entry is rewritten, and keys.json never appears.
      const ready = path.join(root, "ready");
      yield* cli.start(ready, { env: as("granted") });
      const readyRecord = yield* cli.readRecord(ready);
      expect(readyRecord.state).toBe("ready");
      const stored = yield* storedKeys(readyRecord.id);
      const storeRotation = yield* cli.rotate(ready, as("granted"));
      expect(storeRotation.code).toBe(0);
      const restored = yield* storedKeys(readyRecord.id);
      expect(restored.apiKey).not.toBe(stored.apiKey);
      expect(restored.encryptionKey).toBe(stored.encryptionKey);
      expect(yield* fs.exists(path.join(ready, "keys.json"))).toBe(false);
      expect(yield* cli.readRecord(ready)).toEqual(readyRecord);
      yield* accepts(ready, as("granted"), restored.apiKey, stored.apiKey);

      // Denied store access changes nothing and says so.
      const denied = yield* cli.rotate(ready, as("denied"));
      expect(denied.code).toBe(1);
      expect(denied.stderr).toContain("Access to the OS credential store was denied");
      expect(denied.stderr).toContain(unchanged);
      expect(yield* storedKeys(readyRecord.id)).toEqual(restored);

      // Supplied keys are never stored, so they cannot be rotated here.
      const supplied = yield* cli.rotate(file, {
        ...as("granted"),
        EXECUTOR_API_KEY: after.apiKey,
        EXECUTOR_ENCRYPTION_KEY: after.encryptionKey,
      });
      expect(supplied.code).toBe(1);
      expect(supplied.stderr).toContain("are never stored");
      expect(yield* readKeys(file)).toEqual(after);
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);
