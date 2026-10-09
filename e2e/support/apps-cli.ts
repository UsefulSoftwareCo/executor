/**
 * The real `executor apps` CLI and Git, signed in through the product's browser flow. Each use has
 * its own home. The OS credential store is a stand-in kept in a file, so scenarios run without a
 * Secret Service and never touch the real store, and the browser opener records the sign-in URL
 * the CLI asks for instead of opening a browser.
 */
import {
  Config,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Redacted,
  Schedule,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { connect, type Socket } from "node:net";
import { Evidence } from "./evidence.ts";
import { McpConsent } from "./mcp-consent.ts";

/** The name the CLI registers its OAuth client with, which the consent page shows. */
const cliClient = "Executor CLI";

/** A finished process: its exit code and complete output. */
export interface Finished {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Start the CLI and Git with one home and credential store, removed with the caller's scope. */
export const appsCli = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    processes = yield* ChildProcessSpawner.ChildProcessSpawner,
    evidence = yield* Evidence,
    consent = yield* McpConsent;
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
  /** The Git working copy every `git` command runs in. */
  const checkout = path.join(root, "checkout");
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(bin);
  yield* fs.makeDirectory(checkout);
  yield* fs.writeFileString(
    path.join(root, "keyring.mjs"),
    [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      "const file = process.env.EXECUTOR_E2E_STAND_IN_FILE;",
      'const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});',
      "export class AsyncEntry {",
      "  constructor(service, username) {",
      "    this.key = `${service}\\n${username}`;",
      "  }",
      "  getPassword() {",
      "    return Promise.resolve(read()[this.key] ?? null);",
      "  }",
      "  setPassword(password) {",
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
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
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
   * `executor apps login --host <host>`, approved in the browser as the synthetic owner for the
   * test organization. The consent's grant is revoked with the caller's scope.
   */
  const login = (host: string) =>
    Effect.gen(function* () {
      const running = yield* Effect.forkScoped(cli(["login", "--host", host]));
      const url = yield* fs
        .readFileString(opened)
        .pipe(Effect.retry(Schedule.spaced("200 millis")), Effect.timeout("30 seconds"));
      const clientId = new URL(url).searchParams.get("client_id") ?? "";
      // Browsers race a spare connection when connecting is slow and may leave it open without
      // sending a request. Hold one to the CLI's callback, so sign-in must finish regardless.
      const callback = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
      yield* Effect.acquireRelease(
        Effect.callback<Socket>((resume) => {
          const socket = connect(Number(callback.port), callback.hostname, () =>
            resume(Effect.succeed(socket)),
          );
          socket.once("error", (cause) => resume(Effect.die(cause)));
        }),
        (socket) => Effect.sync(() => socket.destroy()),
      );
      yield* consent.approve({ url: Redacted.make(url), clientId, client: cliClient });
      return { url: new URL(url), finished: yield* Fiber.join(running) };
    });
  return { cli, git, login, checkout, fs, path };
});
