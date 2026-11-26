import {
  Config,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Actors } from "./actors.ts";
import { Api, body } from "./api.ts";
import { Evidence } from "./evidence.ts";
import { withStandInPackage } from "./stand-in-package.ts";
import { heldValue } from "./failure-text.ts";

export interface GrantSettings {
  readonly access?: { readonly kind: "all" } | { readonly kind: "connection"; readonly id: string };
  readonly mode?: "model" | "native" | "browser";
}

export interface Finished {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DeviceCode {
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly userCode: string;
}
const printedCode = (stderr: string): DeviceCode | undefined => {
  const printed = stderr.match(/open (\S+)\nand check that it shows the code ([A-Z]{4}-[A-Z]{4})/u);
  if (printed?.[1] === undefined || printed[2] === undefined) return undefined;
  const link = new URL(printed[1]);
  return {
    verificationUri: link.origin + link.pathname,
    verificationUriComplete: link.href,
    userCode: printed[2],
  };
};

export const appsCli = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    processes = yield* ChildProcessSpawner.ChildProcessSpawner,
    evidence = yield* Evidence,
    api = yield* Api,
    actors = yield* Actors;
  const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
    Config.option,
  );
  const entry = path.resolve(
    Option.isSome(packagedEntry) ? packagedEntry.value : "apps/local/server/src/bin.ts",
  );
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-cli-git-" });
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const opened = path.join(root, "opened-url");
  const noBrowser = path.join(root, "no-browser");
  const browserStays = path.join(root, "browser-stays");
  const openerPid = path.join(root, "opener-pid");
  const checkout = path.join(root, "checkout");
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(bin);
  yield* fs.makeDirectory(noBrowser);
  yield* fs.makeDirectory(browserStays);
  yield* Effect.addFinalizer(() =>
    fs.readFileString(openerPid).pipe(
      Effect.flatMap((pid) => Effect.try(() => process.kill(Number(pid)))),
      Effect.ignore,
    ),
  );
  yield* fs.makeDirectory(checkout);
  const launch = yield* withStandInPackage(
    entry,
    root,
    "@napi-rs/keyring",
    [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      "const file = process.env.EXECUTOR_E2E_STAND_IN_FILE;",
      'const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});',
      "// As on a Linux server without a Secret Service: every call is refused.",
      'const absent = () => Promise.reject(new Error("no OS credential store"));',
      'const unavailable = process.env.EXECUTOR_E2E_NO_OS_STORE === "1";',
      "export class AsyncEntry {",
      "  constructor(service, username) {",
      "    this.key = `${service}\\n${username}`;",
      "  }",
      "  getPassword() {",
      "    if (unavailable) return absent();",
      "    return Promise.resolve(read()[this.key] ?? null);",
      "  }",
      "  setPassword(password) {",
      "    if (unavailable) return absent();",
      "    writeFileSync(file, JSON.stringify({ ...read(), [this.key]: password }));",
      "    return Promise.resolve();",
      "  }",
      "  deletePassword() {",
      "    if (unavailable) return absent();",
      "    const { [this.key]: removed, ...kept } = read();",
      "    writeFileSync(file, JSON.stringify(kept));",
      "    return Promise.resolve(removed !== undefined);",
      "  }",
      "}",
    ].join("\n"),
  );
  for (const opener of ["open", "xdg-open"])
    yield* fs.writeFileString(
      path.join(bin, opener),
      `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`,
      { mode: 0o755 },
    );
  for (const opener of ["open", "xdg-open"])
    yield* fs.writeFileString(path.join(noBrowser, opener), "#!/bin/sh\nexit 3\n", {
      mode: 0o755,
    });
  for (const opener of ["open", "xdg-open"])
    yield* fs.writeFileString(
      path.join(browserStays, opener),
      `#!/bin/sh\nprintf '%s' "$$" > '${openerPid}'\nprintf '%s' "$1" > '${opened}'\nexec sleep 600\n`,
      { mode: 0o755 },
    );
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    DISPLAY: ":0",
    HOME: home,
    DO_NOT_TRACK: "1",
    EXECUTOR_E2E_STAND_IN_FILE: path.join(root, "store.json"),
  };
  const run = (
    label: string,
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly env: Record<string, string>; readonly input?: string | undefined },
  ) =>
    evidence.step(
      label,
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* processes.spawn(
            ChildProcess.make(command, args, {
              cwd: checkout,
              extendEnv: false,
              env: options.env,
              stdin:
                options.input === undefined
                  ? "ignore"
                  : Stream.make(new TextEncoder().encode(options.input)),
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: "3 seconds",
            }),
          );
          const [code, stdout, stderr] = yield* Effect.all(
            [
              child.exitCode,
              child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            ],
            { concurrency: 3 },
          ).pipe(Effect.timeout("90 seconds"));
          return { code: Number(code), stdout, stderr } satisfies Finished;
        }),
      ),
    );
  const cli = (args: ReadonlyArray<string>) =>
    run(`executor apps ${args.join(" ")}`, launch.command, [...launch.prefix, "apps", ...args], {
      env,
    });
  const executor = (
    args: ReadonlyArray<string>,
    options: { readonly extra?: Record<string, string>; readonly input?: string } = {},
  ) =>
    run(`executor ${args.join(" ")}`, launch.command, [...launch.prefix, ...args], {
      env: { ...env, ...options.extra },
      input: options.input,
    });
  const helper = `!${[launch.command, ...launch.prefix].map((part) => `'${part}'`).join(" ")} apps credential`;
  const git = (args: ReadonlyArray<string>, input?: string) =>
    run(`git ${args[0] ?? ""}`, "git", args, {
      input,
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: helper,
        GIT_CONFIG_KEY_1: "credential.useHttpPath",
        GIT_CONFIG_VALUE_1: "true",
        GIT_CONFIG_KEY_2: "commit.gpgsign",
        GIT_CONFIG_VALUE_2: "false",
        GIT_AUTHOR_NAME: "Git remote verification",
        GIT_AUTHOR_EMAIL: "git-remote@example.test",
        GIT_COMMITTER_NAME: "Git remote verification",
        GIT_COMMITTER_EMAIL: "git-remote@example.test",
      },
    });
  const deviceLogin = (
    host: string,
    browser: "opens" | "stays" | "fails" | "remote",
    command: ReadonlyArray<string> = ["login"],
  ) =>
    Effect.gen(function* () {
      const args = [...command, "--host", host];
      const shown = yield* Deferred.make<DeviceCode>();
      const running = yield* Effect.forkScoped(
        evidence.step(
          `executor ${args.join(" ")}`,
          Effect.scoped(
            Effect.gen(function* () {
              const child = yield* processes.spawn(
                ChildProcess.make(launch.command, [...launch.prefix, ...args], {
                  cwd: checkout,
                  extendEnv: false,
                  env:
                    browser === "fails"
                      ? { ...env, PATH: `${noBrowser}:${process.env.PATH ?? ""}` }
                      : browser === "stays"
                        ? { ...env, PATH: `${browserStays}:${process.env.PATH ?? ""}` }
                        : browser === "remote"
                          ? { ...env, SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" }
                          : env,
                  stdin: "ignore",
                  stdout: "pipe",
                  stderr: "pipe",
                  forceKillAfter: "3 seconds",
                }),
              );
              let stderr = "";
              const [code, stdout] = yield* Effect.all(
                [
                  child.exitCode,
                  child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                  child.stderr.pipe(
                    Stream.decodeText(),
                    Stream.runForEach((chunk) => {
                      stderr += chunk;
                      const printed = printedCode(stderr);
                      return printed === undefined
                        ? Effect.void
                        : Deferred.succeed(shown, printed).pipe(Effect.asVoid);
                    }),
                  ),
                ],
                { concurrency: 3 },
              ).pipe(Effect.timeout("90 seconds"));
              return { code: Number(code), stdout, stderr } satisfies Finished;
            }),
          ),
        ),
      );
      const printed = yield* Deferred.await(shown).pipe(Effect.timeout("30 seconds"));
      return { ...printed, finished: running };
    });
  const login = (
    host: string,
    command: ReadonlyArray<string> = ["login"],
    settings?: GrantSettings,
  ) =>
    Effect.gen(function* () {
      const started = yield* deviceLogin(host, "opens", command);
      const lookup = yield* api.request(
        actors.owner,
        "GET",
        `/api/auth/device/request?user_code=${encodeURIComponent(started.userCode)}`,
      );
      const { clientId } = yield* body(Schema.Struct({ clientId: Schema.String }), lookup);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const grants = yield* body(
            Schema.Array(Schema.Struct({ id: Schema.String, clientId: Schema.String })),
            yield* api.request(actors.owner, "GET", "/api/auth/oauth2/get-consents"),
          );
          for (const grant of grants.filter((item) => item.clientId === clientId))
            yield* api.request(actors.owner, "POST", "/api/auth/oauth2/delete-consent", {
              id: grant.id,
            });
        }).pipe(Effect.orDie),
      );
      const decided = yield* api.request(
        actors.owner,
        "POST",
        "/api/auth/device/decide",
        { user_code: started.userCode, accept: true },
        {
          "x-executor-organization": actors.organization.id,
          ...(settings === undefined
            ? {}
            : { "x-executor-grant-settings": JSON.stringify(settings) }),
        },
      );
      if (decided.status !== 200) return yield* Effect.die(`device decision ${decided.status}`);
      return { ...started, clientId, finished: yield* Fiber.join(started.finished) };
    });
  const browserOpened = fs
    .exists(opened)
    .pipe(
      Effect.flatMap((exists) =>
        exists ? fs.readFileString(opened).pipe(Effect.map(Option.some)) : Effect.succeedNone,
      ),
    );
  const openedPage = fs
    .readFileString(opened)
    .pipe(Effect.retry(Schedule.spaced("100 millis")), Effect.timeout("10 seconds"));
  const openerRunning = fs.readFileString(openerPid).pipe(
    Effect.flatMap((pid) => Effect.try(() => process.kill(Number(pid), 0))),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  const withoutOsStore = Effect.sync(() => {
    env.EXECUTOR_E2E_NO_OS_STORE = "1";
  });
  const storedCredential = (service: string, account: string) =>
    fs.readFileString(path.join(root, "store.json")).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, heldValue(Schema.String))),
        ),
      ),
      Effect.map((store) => Option.fromUndefinedOr(store[`${service}\n${account}`])),
    );
  const command = (args: ReadonlyArray<string>) => ({
    command: launch.command,
    args: [...launch.prefix, ...args],
    env: { ...env },
  });
  const osStoreUsed = fs.exists(path.join(root, "store.json"));
  return {
    cli,
    executor,
    command,
    git,
    login,
    deviceLogin,
    browserOpened,
    openedPage,
    openerRunning,
    withoutOsStore,
    osStoreUsed,
    storedCredential,
    home,
    checkout,
    fs,
    path,
  };
});
