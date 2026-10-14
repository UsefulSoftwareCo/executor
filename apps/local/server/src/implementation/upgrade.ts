/**
 * `executor upgrade`: install a newer release the way this copy was installed. A standalone install
 * downloads the release archive, checks it, and switches to it, keeping the version it replaced for
 * `--rollback`. An npm-family install runs its package manager, after checking that the release's
 * launcher supports this Node. Either way it runs only on request, confirms the new command works,
 * and says when a running server still uses the old version. It never restarts a server.
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
import { dataDirectoryConfig } from "../contracts/config.ts";
import { UpgradeFailed } from "../contracts/startup.ts";
import { runningServer } from "./server-record.ts";
import {
  installVersion,
  linkedVersion,
  standaloneInstall,
  switchVersion,
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
 * Each package manager's global install. npm can skip the optional dependency that carries the
 * native runtime, which leaves a launcher that cannot start, so it must be asked to include it.
 */
const installArgs = (method: GlobalInstaller, version: string): ReadonlyArray<string> => {
  const spec = `executor@${version}`;
  switch (method) {
    case "npm":
      return ["install", "-g", spec, "--include=optional"];
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

/** Start `executor --version` the way a shell would, through PATH. */
const installedVersion = (platform: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const shell = throughShell(platform, "executor", ["--version"]);
      const child = yield* spawner.spawn(
        ChildProcess.make(shell.command, shell.args, {
          extendEnv: true,
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [code, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode,
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout(Duration.seconds(60)));
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

/** Say when a server from this data directory still runs another version. */
const restartNotice = (target: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const server = yield* runningServer(path.resolve(yield* dataDirectoryConfig));
    if (server !== undefined && server.version !== target)
      yield* Console.log(
        `The Executor server at ${server.url} (process ${server.pid}) is still running ${server.version === undefined ? "a development build" : `v${server.version}`}. Stop it, then start it again with \`${server.command}\` to use v${target}.`,
      );
  });

/** Switch a standalone install back to the version it ran before its last upgrade. */
const rollback = (options: UpgradeOptions, host: UpgradeHost) =>
  Effect.gen(function* () {
    const install = yield* standaloneInstall(host.executable, host.platform);
    if (Option.isNone(install))
      return yield* failed(
        "not-standalone",
        "Only an install from the Executor install script keeps a previous version to roll back to. Install the version you want with the package manager you used, such as: npm install -g executor@<version> --include=optional. Nothing was changed.",
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
    yield* switchVersion(install.value, previous.value, host.platform);
    yield* Console.log(
      `Switched Executor from v${current} back to v${previous.value}. Run executor upgrade --rollback again to return to v${current}.`,
    );
    yield* restartNotice(previous.value);
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
        "This is a development build of Executor without a release version, so it cannot upgrade itself. Install a release with: npm install -g executor@beta --include=optional",
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
          `${host.executable} is not in an install script's versions directory, so executor upgrade cannot replace it. Reinstall with the Executor install script, or with npm: npm install -g executor@${target} --include=optional. Nothing was changed.`,
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
      yield* switchVersion(install.value, target, host.platform);
      yield* Console.log(
        `Upgraded Executor from v${current.value} to v${target}. v${current.value} stays installed: run executor upgrade --rollback to switch back.`,
      );
      yield* restartNotice(target);
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

    yield* Console.log(`Upgrading Executor v${current.value} to v${target}: ${command}`);
    const installed = yield* runStreaming(method, installArgs(method, target), host.platform).pipe(
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
    const check = yield* installedVersion(host.platform).pipe(Effect.result);
    if (Result.isFailure(check)) return yield* verify("`executor --version` could not be started.");
    if (check.success.code !== 0)
      return yield* verify(
        `\`executor --version\` failed with code ${check.success.code}${check.success.stderr === "" ? "." : `:\n${lastLines(check.success.stderr, 20)}\n`}`,
      );
    if (check.success.stdout !== `executor v${target}`)
      return yield* verify(
        `\`executor --version\` printed "${check.success.stdout}". Another installation may come first on your PATH.`,
      );
    yield* Console.log(`Upgraded Executor from v${current.value} to v${target}.`);
    yield* restartNotice(target);
  });
