/**
 * `executor upgrade`: install a newer release the way this copy was installed. A standalone install
 * downloads the release archive, checks it, and switches to it, keeping the version it replaced for
 * `--rollback`. An npm-family install runs its package manager, after checking that the release's
 * launcher supports this Node. Either way it runs only on request and confirms the new command
 * works. Both replace the files a running background server uses, so that server is stopped first
 * and started again on the new version afterwards, or on this one if the upgrade fails.
 */
import {
  compareReleaseVersions,
  releaseChannel,
  ReleaseVersion,
} from "@executor-js/utils/release-version";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import {
  Console,
  Duration,
  Effect,
  Exit,
  Option,
  Path,
  Ref,
  Result,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { Prompt } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { UpgradeFailed } from "../contracts/startup.ts";
import { discover, ensure, registered, stop } from "./service-client.ts";
import { serviceDirectory } from "./service-files.ts";
import {
  installVersion,
  linkedVersion,
  type StandaloneInstall,
  standaloneInstall,
  switchVersion,
  versionExecutable,
} from "./standalone-install.ts";
import {
  currentRelease,
  fetchReleases,
  type GlobalInstaller,
  installMethod,
  isOneShot,
  newerRelease,
  npmRegistry,
} from "./update-notice.ts";

/** The process facts the entry point supplies. */
export interface UpgradeHost {
  /** The file that started the CLI, whose location shows how it was installed. */
  readonly entry: string | undefined;
  /**
   * The Node.js version, without the leading v, that runs the npm launcher or the CLI; none for a
   * release executable started directly, which needs no Node.
   */
  readonly node: string | undefined;
  /** The running executable, which a standalone install keeps under its versions directory. */
  readonly executable: string;
  readonly platform: string;
  readonly arch: string;
}

export interface UpgradeOptions {
  readonly version: Option.Option<string>;
  readonly method: Option.Option<GlobalInstaller>;
  readonly yes: boolean;
  readonly rollback: boolean;
}

/**
 * Each package manager's global install. It installs only the launcher, which downloads the
 * release's runtime the first time it starts.
 */
const installArgs = (method: GlobalInstaller, version: string): ReadonlyArray<string> => {
  const spec = `executor@${version}`;
  switch (method) {
    case "npm":
      return ["install", "-g", spec];
    case "pnpm":
      return ["add", "-g", spec];
    case "bun":
      return ["add", "-g", spec];
    case "yarn":
      return ["global", "add", spec];
  }
};
const installCommand = (method: GlobalInstaller, version: string) =>
  [method, ...installArgs(method, version)].join(" ");

const failed = (reason: UpgradeFailed["reason"], message: string) =>
  new UpgradeFailed({ reason, message });

const Release = Schema.Struct({
  version: Schema.String,
  engines: Schema.optional(Schema.Struct({ node: Schema.optional(Schema.String) })),
});

/** The release's published manifest, or undefined when the registry has no such version. */
const fetchRelease = (version: string) =>
  Effect.gen(function* () {
    const registry = yield* npmRegistry;
    return yield* HttpClient.get(`${registry}/executor/${version}`).pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.succeed(undefined)
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap((ok) => ok.json),
              Effect.flatMap(Schema.decodeUnknownEffect(Release)),
            ),
      ),
      Effect.timeout(Duration.seconds(10)),
      // The body is read before the client's connections close with this layer.
      Effect.provide(NodeHttpClient.layerNodeHttp),
    );
  });

const numbers = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10));

/**
 * Whether `node` meets an engines range. Releases publish `>=major.minor.patch`; any other range
 * is reported as one this command cannot check rather than guessed at.
 */
const meetsNode = (node: string, range: string) => {
  const match = /^>=\s*v?(\d+(?:\.\d+){0,2})$/u.exec(range.trim());
  if (match === null) return undefined;
  const minimum = numbers(match[1] ?? "");
  const current = numbers(node);
  for (const [index, part] of minimum.entries()) {
    const have = current[index] ?? 0;
    if (have !== part) return have > part;
  }
  return true;
};

/**
 * Windows package managers and command shims are .cmd scripts that only cmd.exe starts. It is named
 * from ComSpec rather than found on PATH, as Bun's `shell` option looks for it. The arguments here
 * are package specs and flags, which need no quoting.
 */
const throughShell = (platform: string, command: string, args: ReadonlyArray<string>) =>
  platform === "win32"
    ? {
        // An empty value, as a stripped environment can pass, names no shell either.
        command:
          process.env.ComSpec || `${process.env.SystemRoot || "C:\\Windows"}\\System32\\cmd.exe`,
        args: ["/d", "/s", "/c", [command, ...args].join(" ")],
      }
    : { command, args };

/** Run one command with its output streamed through; resolves to its exit code and stderr. */
const runStreaming = (command: string, args: ReadonlyArray<string>, platform: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const stdio = yield* Stdio.Stdio;
      const captured = yield* Ref.make("");
      const decoder = new TextDecoder();
      const shell = throughShell(platform, command, args);
      const child = yield* spawner.spawn(
        ChildProcess.make(shell.command, shell.args, {
          extendEnv: true,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "pipe",
        }),
      );
      const [code] = yield* Effect.all(
        [
          child.exitCode,
          child.stderr.pipe(
            Stream.tap((chunk) =>
              Ref.update(captured, (text) => text + decoder.decode(chunk, { stream: true })),
            ),
            Stream.run(stdio.stderr({ endOnDone: false })),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return { code: Number(code), stderr: yield* Ref.get(captured) };
    }),
  );

/** How to start the installed `executor`: through PATH, or a standalone version's executable. */
type Installed = (args: ReadonlyArray<string>) => {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

/** `executor` the way a shell would start it, through PATH. */
const onPath =
  (platform: string): Installed =>
  (args) =>
    throughShell(platform, "executor", args);

/** Run the installed `executor` with `args` to exit, with its output captured. */
const runInstalled = (
  installed: Installed,
  args: ReadonlyArray<string>,
  timeout: Duration.Input,
  env: Readonly<Record<string, string>> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { command, args: argv } = installed(args);
      const child = yield* spawner.spawn(
        ChildProcess.make(command, argv, { extendEnv: true, env, stdout: "pipe", stderr: "pipe" }),
      );
      const [code, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode,
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout(timeout));
      return { code: Number(code), stdout: stdout.trim(), stderr: stderr.trim() };
    }),
  );

const lastLines = (text: string, count: number) =>
  text.trimEnd().split("\n").slice(-count).join("\n");

/** Ask on a terminal. Without one, `whenNotInteractive` decides: proceed, or stop with its error. */
const confirm = (
  message: string,
  initial: boolean,
  yes: boolean,
  whenNotInteractive: UpgradeFailed | undefined,
) =>
  Effect.gen(function* () {
    if (yes) return;
    const stdio = yield* Stdio.Stdio;
    const interactive = (yield* stdio.stdinIsTerminal) && (yield* stdio.stdoutIsTerminal);
    if (!interactive) {
      if (whenNotInteractive !== undefined) return yield* whenNotInteractive;
      return;
    }
    const accepted = yield* Prompt.Confirm({ message, initial }).pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!accepted) return yield* failed("cancelled", "Upgrade cancelled. Nothing was changed.");
  });

/** The version a development build's server reports. It runs from a checkout, not an install. */
const developmentVersion = "0.0.0-dev";

/** Say when the background server for this data directory still runs another version. */
const restartNotice = (directory: string, target: string) =>
  Effect.gen(function* () {
    const service = yield* discover(directory);
    if (Option.isNone(service) || service.value.version === target) return;
    const running =
      service.value.version === developmentVersion
        ? "a development build"
        : `v${service.value.version}`;
    yield* Console.log(
      `The background Executor still runs ${running}. It switches to v${target} the next time you run \`executor\`, or now with \`executor service restart\`.`,
    );
  });

/**
 * What became of this data directory's background server before an upgrade replaced files:
 * nothing to stop, stopped, or still running because it did not stop.
 */
type Paused =
  | { readonly state: "none" }
  | { readonly state: "stopped" }
  | { readonly state: "running"; readonly pid: number; readonly message: string };

/**
 * Stop the background server, which may run from the files an upgrade is about to replace or
 * remove. A development build's server runs from its checkout and keeps running.
 */
const pauseService = (directory: string) =>
  Effect.gen(function* () {
    const service = yield* registered(directory);
    if (Option.isNone(service) || service.value.version === developmentVersion)
      return { state: "none" } satisfies Paused;
    yield* Console.log(
      `Stopping the background Executor (v${service.value.version}) until the upgrade is done.`,
    );
    return yield* stop(directory).pipe(
      Effect.as<Paused>({ state: "stopped" }),
      Effect.catch((error) =>
        Effect.succeed<Paused>({
          state: "running",
          pid: service.value.pid,
          message: error.message,
        }),
      ),
    );
  });

/**
 * Run `change` with the background server paused. If it fails or is interrupted after the server
 * stopped, this CLI, which the failed change left in place, starts the server again.
 */
const whilePaused = <A, E, R>(directory: string, paused: Paused, change: Effect.Effect<A, E, R>) =>
  paused.state !== "stopped"
    ? change
    : change.pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : ensure(directory, { version: "ignore" }).pipe(
                Effect.asVoid,
                Effect.catch(() =>
                  Console.error(
                    "The background Executor stopped for the upgrade and could not start again. Start it with `executor service start`.",
                  ),
                ),
              ),
        ),
      );

/**
 * After a successful upgrade, start the background server it stopped with the new version's own
 * `executor service start`, and say whether it runs that version. A server that was not stopped
 * gets the restart notice instead. A release from before the background service, which a rollback
 * or a downgrade can install, has no `executor service`: it refuses `service status`, which every
 * later release answers, and its server runs in the foreground instead.
 */
const resumeService = (directory: string, paused: Paused, installed: Installed, version: string) =>
  Effect.gen(function* () {
    if (paused.state !== "stopped") return yield* restartNotice(directory, version);
    const environment = { EXECUTOR_DATA_DIR: directory };
    const started = yield* runInstalled(
      installed,
      ["service", "start"],
      Duration.minutes(3),
      environment,
    ).pipe(Effect.result);
    const service = yield* discover(directory);
    if (Option.isSome(service))
      return service.value.version === version
        ? yield* Console.log(`Restarted the background Executor on v${version}.`)
        : yield* restartNotice(directory, version);
    const status = yield* runInstalled(
      installed,
      ["service", "status"],
      Duration.seconds(30),
      environment,
    ).pipe(Effect.result);
    if (Result.isSuccess(status) && status.success.code !== 0)
      return yield* Console.error(
        `v${version} predates the background Executor, so the one stopped for the upgrade was not started again. Run \`executor serve\`, or \`executor\` to also open the dashboard, and keep it running while your agents use Executor.`,
      );
    const output =
      Result.isSuccess(started) && started.success.code !== 0 && started.success.stderr !== ""
        ? `\n${lastLines(started.success.stderr, 20)}`
        : "";
    yield* Console.error(
      `The background Executor stopped for the upgrade and did not start again on v${version}.${output}\nStart it with \`executor service start\`.`,
    );
  });

/** A standalone install's version, started from its own executable. */
const versionInstalled = (install: StandaloneInstall, version: string, platform: string) =>
  Effect.map(versionExecutable(install, version, platform), (command): Installed => (args) => ({
    command,
    args,
  }));

/**
 * Switch a standalone install to `version` with the background server paused. A server that did
 * not stop keeps the version it runs from installed.
 */
const switchPaused = (
  directory: string,
  install: StandaloneInstall,
  version: string,
  platform: string,
) =>
  Effect.gen(function* () {
    const paused = yield* pauseService(directory);
    if (paused.state === "running") yield* Console.error(paused.message);
    yield* whilePaused(
      directory,
      paused,
      Effect.gen(function* () {
        const running = yield* registered(directory);
        yield* switchVersion(
          install,
          version,
          platform,
          Option.toArray(Option.map(running, (service) => service.version)),
        );
      }),
    );
    return paused;
  });

/** Switch a standalone install back to the version it ran before its last upgrade. */
const rollback = (options: UpgradeOptions, host: UpgradeHost) =>
  Effect.gen(function* () {
    const install = yield* standaloneInstall(host.executable, host.platform);
    if (Option.isNone(install))
      return yield* failed(
        "not-standalone",
        "Only an install from the Executor install script keeps a previous version to roll back to. Install the version you want with the package manager you used, such as: npm install -g executor@<version>. Nothing was changed.",
      );
    const previous = yield* linkedVersion(install.value.root, "previous");
    if (Option.isNone(previous))
      return yield* failed(
        "no-previous-version",
        `${install.value.root} has no previous version to roll back to. Nothing was changed.`,
      );
    const current = Option.getOrElse(
      yield* linkedVersion(install.value.root, "current"),
      () => install.value.version,
    );
    yield* confirm(
      `Switch Executor from v${current} back to v${previous.value}?`,
      true,
      options.yes,
      undefined,
    );
    const directory = yield* serviceDirectory;
    const paused = yield* switchPaused(directory, install.value, previous.value, host.platform);
    yield* Console.log(
      `Switched Executor from v${current} back to v${previous.value}. Run executor upgrade --rollback again to return to v${current}.`,
    );
    yield* resumeService(
      directory,
      paused,
      yield* versionInstalled(install.value, previous.value, host.platform),
      previous.value,
    );
  });

export const upgrade = (options: UpgradeOptions, host: UpgradeHost) =>
  Effect.gen(function* () {
    if (options.rollback) return yield* rollback(options, host);
    const path = yield* Path.Path;
    const current = yield* currentRelease;
    const detected = yield* installMethod(host.entry);
    const method = Option.isSome(options.method) ? options.method.value : detected;
    if (method === "brew") {
      const formula =
        /\/Cellar\/(executor(?:-beta)?)\//iu.exec(host.entry ?? "")?.[1] ?? "executor";
      yield* Console.log(
        `This Executor was installed with Homebrew, which keeps it up to date. Run: brew upgrade ${formula}`,
      );
      return;
    }
    const given = Option.getOrUndefined(options.version);
    const requested =
      given === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(ReleaseVersion)(given.replace(/^v/u, "")).pipe(
            Effect.mapError(() =>
              failed(
                "invalid-version",
                `${given} is not an Executor release version, such as 2.0.0-beta.16. Nothing was changed.`,
              ),
            ),
          );

    // A one-shot runner fetches the release each run; there is no installed copy to replace.
    if (isOneShot(method)) {
      const spec = requested ?? (Option.isSome(current) ? releaseChannel(current.value) : "beta");
      yield* Console.log(
        `This Executor runs through ${method}, which fetches the release each time, so there is nothing to upgrade. Run the release with: ${method} executor@${spec}`,
      );
      return;
    }
    if (Option.isNone(current))
      return yield* failed(
        "development-build",
        "This is a development build of Executor without a release version, so it cannot upgrade itself. Install a release with: npm install -g executor@beta",
      );

    const registry = yield* npmRegistry;
    const unavailable = (what: string) =>
      failed(
        "registry-unavailable",
        `Executor could not read ${what} from ${registry}. Check your connection or EXECUTOR_NPM_REGISTRY, then try again. Nothing was changed.`,
      );
    const target =
      requested ??
      newerRelease(
        current.value,
        yield* fetchReleases(Duration.seconds(10)).pipe(
          Effect.mapError(() => unavailable("the newest release")),
        ),
      );
    if (target === undefined) {
      yield* Console.log(
        `Executor v${current.value} is already the newest ${releaseChannel(current.value)} release.`,
      );
      return;
    }
    if (target === current.value) {
      yield* Console.log(`Executor v${current.value} is already installed.`);
      return;
    }

    const release = yield* fetchRelease(target).pipe(
      Effect.mapError(() => unavailable(`release v${target}`)),
    );
    if (release === undefined)
      return yield* failed(
        "unknown-release",
        `${registry} has no Executor release v${target}. Nothing was changed.`,
      );

    // A standalone install carries its own runtime. The npm launcher runs on the person's Node.
    const range = release.engines?.node;
    if (method !== "standalone" && host.node !== undefined && range !== undefined) {
      const meets = meetsNode(host.node, range);
      if (meets === undefined)
        return yield* failed(
          "node-too-old",
          `Executor v${target} requires Node.js ${range}, which executor upgrade cannot check. Check that Node.js v${host.node} meets it, then install the release yourself. Nothing was changed.`,
        );
      if (!meets)
        return yield* failed(
          "node-too-old",
          `Executor v${target} requires Node.js ${range}, and this is Node.js v${host.node}. Upgrade Node.js, then run executor upgrade again. Nothing was changed.`,
        );
    }

    if (method === "standalone") {
      const install = yield* standaloneInstall(host.executable, host.platform);
      if (Option.isNone(install))
        return yield* failed(
          "not-standalone",
          `${host.executable} is not in an install script's versions directory, so executor upgrade cannot replace it. Reinstall with the Executor install script, or with npm: npm install -g executor@${target}. Nothing was changed.`,
        );
      if (compareReleaseVersions(target, current.value) < 0)
        yield* confirm(
          `Downgrade Executor from v${current.value} to v${target}?`,
          false,
          options.yes,
          failed(
            "downgrade-unconfirmed",
            `v${target} is older than the installed v${current.value}. To downgrade, run: executor upgrade ${target} --yes. Nothing was changed.`,
          ),
        );
      else
        yield* confirm(
          `Upgrade Executor from v${current.value} to v${target}?`,
          true,
          options.yes,
          undefined,
        );
      yield* Console.log(
        `Downloading Executor v${target} for ${host.platform}/${host.arch} into ${install.value.root}`,
      );
      yield* installVersion(install.value, target, host.platform, host.arch);
      const directory = yield* serviceDirectory;
      const paused = yield* switchPaused(directory, install.value, target, host.platform);
      yield* Console.log(
        `Upgraded Executor from v${current.value} to v${target}. v${current.value} stays installed: run executor upgrade --rollback to switch back.`,
      );
      yield* resumeService(
        directory,
        paused,
        yield* versionInstalled(install.value, target, host.platform),
        target,
      );
      return;
    }

    if (method === "unknown")
      return yield* failed(
        "unknown-install",
        [
          `Executor could not tell which package manager installed it${host.entry === undefined ? "" : ` (${path.dirname(host.entry)})`}, so it did not install anything.`,
          `Install v${target} with the one you used:`,
          ...(["npm", "pnpm", "bun", "yarn"] as const).map(
            (installer) => `  ${installCommand(installer, target)}`,
          ),
          "Or run: executor upgrade --method <npm|pnpm|bun|yarn>",
        ].join("\n"),
      );

    const command = installCommand(method, target);
    if (compareReleaseVersions(target, current.value) < 0)
      yield* confirm(
        `Downgrade Executor from v${current.value} to v${target} with ${method}?`,
        false,
        options.yes,
        failed(
          "downgrade-unconfirmed",
          `v${target} is older than the installed v${current.value}. To downgrade, run: executor upgrade ${target} --yes. Nothing was changed.`,
        ),
      );
    else
      yield* confirm(
        `Upgrade Executor from v${current.value} to v${target} with ${method}?`,
        true,
        options.yes,
        undefined,
      );

    // The package manager replaces the files the background server runs from; Windows would refuse
    // to replace its running executable.
    const directory = yield* serviceDirectory;
    const paused = yield* pauseService(directory);
    if (paused.state === "running")
      return yield* failed(
        "service-running",
        `${paused.message} ${method} would replace the files it runs from, so Executor v${target} was not installed. End process ${paused.pid}, then run executor upgrade again. Nothing was changed.`,
      );
    yield* Console.log(`Upgrading Executor v${current.value} to v${target}: ${command}`);
    yield* whilePaused(
      directory,
      paused,
      Effect.gen(function* () {
        const installed = yield* runStreaming(
          method,
          installArgs(method, target),
          host.platform,
        ).pipe(
          Effect.mapError(() =>
            failed(
              "install-failed",
              `${method} could not be started. Check that it is installed and on your PATH, or choose another with --method. Nothing was changed.`,
            ),
          ),
        );
        if (installed.code !== 0)
          return yield* failed(
            "install-failed",
            [
              `${method} exited with code ${installed.code} and did not install Executor v${target}.`,
              ...(installed.stderr.trim() === ""
                ? []
                : [`${method} reported:`, lastLines(installed.stderr, 40)]),
              `Fix the problem it reports, then run executor upgrade again, or run: ${command}`,
            ].join("\n"),
          );

        const verify = (detail: string) =>
          failed(
            "verify-failed",
            `${method} installed Executor v${target}, but ${detail} Run \`${host.platform === "win32" ? "where.exe executor" : "type -a executor"}\` to see which executable your shell starts, or reinstall with: ${command}`,
          );
        // The new launcher's first start downloads and checks its release's runtime.
        yield* Console.log(
          `Starting Executor v${target}. Its first start downloads the runtime for this platform.`,
        );
        const check = yield* runInstalled(
          onPath(host.platform),
          ["--version"],
          Duration.minutes(15),
        ).pipe(Effect.result);
        if (Result.isFailure(check))
          return yield* verify("`executor --version` could not be started.");
        if (check.success.code !== 0)
          return yield* verify(
            `\`executor --version\` failed with code ${check.success.code}${check.success.stderr === "" ? "." : `:\n${lastLines(check.success.stderr, 20)}\n`}`,
          );
        if (check.success.stdout !== `executor v${target}`)
          return yield* verify(
            `\`executor --version\` printed "${check.success.stdout}". Another installation may come first on your PATH.`,
          );
      }),
    );
    yield* Console.log(`Upgraded Executor from v${current.value} to v${target}.`);
    yield* resumeService(directory, paused, onPath(host.platform), target);
  });
