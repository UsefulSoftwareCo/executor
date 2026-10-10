/**
 * The real `executor apps` CLI and Git, signed in with a device code. Each use has its own home.
 * The OS credential store is a stand-in kept in a file, so scenarios run without a Secret Service
 * and never touch the real store; it can also be made unavailable, as on a server without one. The
 * browser opener records the approval page the CLI opens instead of opening a browser.
 */
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

/** A finished process: its exit code and complete output. */
export interface Finished {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Where the CLI told the person to approve its sign-in, and the code it showed. */
export interface DeviceCode {
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly userCode: string;
}
/** Read the instructions `executor apps login` prints once it has a code: one link carrying it. */
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

/** Start the CLI and Git with one home and credential store, removed with the caller's scope. */
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
  /** Openers that find no browser, as on a desktop without one configured. */
  const noBrowser = path.join(root, "no-browser");
  /** The Git working copy every `git` command runs in. */
  const checkout = path.join(root, "checkout");
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(bin);
  yield* fs.makeDirectory(noBrowser);
  yield* fs.makeDirectory(checkout);
  yield* fs.writeFileString(
    path.join(root, "keyring.mjs"),
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
      "}",
    ].join("\n"),
  );
  yield* fs.writeFileString(
    path.join(root, "hooks.mjs"),
    [
      'const standIn = new URL("./keyring.mjs", import.meta.url).href;',
      "export async function resolve(specifier, context, next) {",
      '  if (specifier === "@napi-rs/keyring") return { url: standIn, shortCircuit: true };',
      "  return next(specifier, context);",
      "}",
    ].join("\n"),
  );
  yield* fs.writeFileString(
    path.join(root, "register.mjs"),
    'import { register } from "node:module";\nregister("./hooks.mjs", import.meta.url);\n',
  );
  const register = (yield* path.toFileUrl(path.join(root, "register.mjs"))).href;
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
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    // The stand-in openers are a desktop's; without a display the CLI signs in with a code.
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
  /** Run `executor apps <args>`. */
  const cli = (args: ReadonlyArray<string>) =>
    run(`executor apps ${args.join(" ")}`, "node", ["--import", register, entry, "apps", ...args], {
      env,
    });
  // Git runs the CLI as its credential helper, configured as the docs configure it.
  const helper = `!node --import '${register}' '${entry}' apps credential`;
  /** Run Git in the working copy with the CLI as its credential helper and no prompts. */
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
  /**
   * `executor apps login --host <host>`: with an opener that records the page it opens
   * (`browser: "opens"`), one that finds no browser (`"fails"`), or a working opener over SSH
   * (`"remote"`). Returns where the CLI said to approve and the code, as soon as it prints them,
   * and the fiber that ends with the CLI.
   */
  const deviceLogin = (host: string, browser: "opens" | "fails" | "remote") =>
    Effect.gen(function* () {
      const args = ["login", "--host", host];
      const shown = yield* Deferred.make<DeviceCode>();
      const running = yield* Effect.forkScoped(
        evidence.step(
          `executor apps ${args.join(" ")}`,
          Effect.scoped(
            Effect.gen(function* () {
              const child = yield* processes.spawn(
                ChildProcess.make("node", ["--import", register, entry, "apps", ...args], {
                  cwd: checkout,
                  extendEnv: false,
                  env:
                    browser === "fails"
                      ? { ...env, PATH: `${noBrowser}:${process.env.PATH ?? ""}` }
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
  /**
   * `executor apps login --host <host>`, approved for the test organization by the synthetic
   * owner. The grant is revoked with the caller's scope.
   */
  const login = (host: string) =>
    Effect.gen(function* () {
      const started = yield* deviceLogin(host, "opens");
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
        { "x-executor-organization": actors.organization.id },
      );
      if (decided.status !== 200) return yield* Effect.die(`device decision ${decided.status}`);
      return { ...started, finished: yield* Fiber.join(started.finished) };
    });
  /** The page the CLI opened in the browser, if any. Read once the CLI has exited. */
  const browserOpened = fs
    .exists(opened)
    .pipe(
      Effect.flatMap((exists) =>
        exists ? fs.readFileString(opened).pipe(Effect.map(Option.some)) : Effect.succeedNone,
      ),
    );
  /** The page the CLI opens once it has printed its code. */
  const openedPage = fs
    .readFileString(opened)
    .pipe(Effect.retry(Schedule.spaced("100 millis")), Effect.timeout("10 seconds"));
  /** Make the OS credential store unavailable to every later command. */
  const withoutOsStore = Effect.sync(() => {
    env.EXECUTOR_E2E_NO_OS_STORE = "1";
  });
  /** Whether anything reached the OS credential store stand-in. */
  const osStoreUsed = fs.exists(path.join(root, "store.json"));
  return {
    cli,
    git,
    login,
    deviceLogin,
    browserOpened,
    openedPage,
    withoutOsStore,
    osStoreUsed,
    home,
    checkout,
    fs,
    path,
  };
});
