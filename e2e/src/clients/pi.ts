// Drive the REAL Pi installation path for @executor-js/pi: pack the package the
// way the release does, hand the tarball to Pi's own package manager (what
// `pi install npm:…` runs), and let Pi discover, load, and wrap the extension
// itself. Everything past the `installAndPersist` call is Pi's code — npm
// install, the `pi.extensions` manifest, the jiti loader, the default-export
// call, the tool wrapper, the slash-command dispatcher.
//
// Pi needs an LLM provider only to run a turn. Installing, loading, registering
// tools, and dispatching `/executor` need none, so this stays headless: no
// model is configured, and the tools are invoked the way Pi's agent loop
// invokes them (AgentTool.execute) instead of through a model.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

/** Pi's wrapped tool and its result, named off the session so this file needs
 *  no direct dependency on pi-agent-core. */
type PiTool = NonNullable<AgentSession["state"]["tools"]>[number];
type PiToolResult = Awaited<ReturnType<PiTool["execute"]>>;

const EXTENSION_PACKAGE_DIR = fileURLToPath(
  new URL("../../../packages/hosts/pi/", import.meta.url),
);

/** A message the extension pushed to Pi's UI (what `/executor` prints). */
export interface PiNotice {
  readonly message: string;
  readonly type: "info" | "warning" | "error";
}

export interface PiHome {
  /** Absolute paths of the extension files Pi loaded, from Pi's own loader. */
  readonly loadedExtensions: readonly string[];
  /** Every tool in Pi's registry after the extension registered its own. */
  readonly toolNames: readonly string[];
  /** Invoke a tool through Pi's wrapper, as Pi's agent loop does. */
  readonly callTool: (
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<PiToolResult>;
  /** Type a slash command into Pi and collect what the extension notified. */
  readonly runCommand: (text: string) => Promise<readonly PiNotice[]>;
  /** Quit the session the way Pi does, so `session_shutdown` handlers run. */
  readonly close: () => Promise<void>;
}

/** The text a model would read off a tool result, images and the rest dropped. */
export const piToolText = (result: PiToolResult): string =>
  result.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");

/**
 * The package's manifest, minus `devDependencies`.
 *
 * Packing outside the workspace means no lockfile, and the dev block's
 * `catalog:` / `workspace:*` specifiers can only be resolved from one. Dropping
 * it costs nothing that this test could observe — npm never installs a
 * dependency's dev deps — while `dependencies` and `peerDependencies`, the two
 * blocks npm acts on, are plain ranges and pass through untouched. Should a
 * `workspace:*` ever land in one of those, `bun pm pack` fails here loudly
 * rather than shipping something the tarball can't install.
 */
const stagedManifest = (): string => {
  const manifest = JSON.parse(
    readFileSync(join(EXTENSION_PACKAGE_DIR, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  delete manifest.devDependencies;
  return `${JSON.stringify(manifest, null, 2)}\n`;
};

/**
 * Build and pack the extension into a tarball, without touching the workspace.
 *
 * `bun run build` is deliberately NOT used: tsup runs with `clean: true`, so a
 * second target packaging the same package concurrently (vitest runs projects
 * in parallel) would have its `dist/` deleted mid-pack. Both compilers run with
 * the package as cwd — that is where their configs and dependencies are — but
 * emit into this run's own staging dir, which nothing else can reach.
 *
 * What lands in the archive is `files` applied to that build, i.e. the same
 * artifact npm would serve. The release's `publishConfig.exports` rewrite is
 * absent and irrelevant: Pi resolves the extension by path (`pi.extensions`),
 * and the published `exports` map is what `scripts/smoke-test-packed.ts` covers.
 */
const packExtension = (destination: string): string => {
  const staging = join(destination, "package");
  const dist = join(staging, "dist");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "package.json"), stagedManifest());

  const run = (command: string, args: readonly string[]): void => {
    execFileSync(join(EXTENSION_PACKAGE_DIR, "node_modules", ".bin", command), args, {
      cwd: EXTENSION_PACKAGE_DIR,
      stdio: "pipe",
    });
  };
  run("tsup", ["--out-dir", dist]);
  run("tsc", ["-p", "tsconfig.build.json", "--outDir", join(dist, "types")]);

  execFileSync("bun", ["pm", "pack", "--destination", destination], {
    cwd: staging,
    stdio: "pipe",
  });
  const tarball = readdirSync(destination).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) throw new Error(`bun pm pack produced no tarball in ${destination}`);
  return join(destination, tarball);
};

/**
 * The extension reads its endpoint and token from the environment, and it runs
 * in this process — so the environment IS this process's. Set before load,
 * restored on close.
 */
const withEnv = (env: Record<string, string>): (() => void) => {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
};

/**
 * Install the packed extension into a throwaway Pi and start a session with it.
 *
 * `installAndPersist` writes `npm:@executor-js/pi@…` into the agent dir's
 * settings.json and npm-installs the tarball under it — the same two steps
 * `pi install npm:@executor-js/pi` performs, against the same code.
 */
export const installPi = async (env: Record<string, string>): Promise<PiHome> => {
  const root = mkdtempSync(join(tmpdir(), "e2e-pi-"));
  // Until the handle exists there is nothing for the scenario to hang a
  // finalizer on, so everything past the temp dir's creation — the build, the
  // pack, the install — undoes its own state on the way out. `restoreEnv` is
  // only defined once the environment has actually been touched.
  let restoreEnv: (() => void) | undefined;
  try {
    const tarball = packExtension(root);
    restoreEnv = withEnv(env);
    return await startPi(root, tarball, restoreEnv);
  } catch (error) {
    restoreEnv?.();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
};

const startPi = async (root: string, tarball: string, restoreEnv: () => void): Promise<PiHome> => {
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  for (const dir of [agentDir, projectDir]) mkdirSync(dir, { recursive: true });

  const settingsManager = SettingsManager.create(projectDir, agentDir);
  const packageManager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager });
  await packageManager.installAndPersist(`npm:@executor-js/pi@file:${tarball}`);

  // Pi's own resource discovery: read the installed packages out of settings,
  // follow each package's `pi` manifest, load what it names.
  const resourceLoader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager });
  await resourceLoader.reload();
  const extensions = resourceLoader.getExtensions();
  if (extensions.errors.length > 0) {
    throw new Error(
      `Pi failed to load the extension: ${extensions.errors
        .map((failure) => `${failure.path}: ${failure.error}`)
        .join("; ")}`,
    );
  }

  const { session } = await createAgentSession({
    cwd: projectDir,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(projectDir),
  });

  const notices: PiNotice[] = [];
  // Headless: there is no terminal to draw dialogs into, and the extension only
  // ever notifies. Anything interactive would be a bug in the extension, so it
  // is left off this context rather than stubbed into silence.
  const ui: Pick<ExtensionUIContext, "notify"> = {
    notify: (message, type) => notices.push({ message, type: type ?? "info" }),
  };
  await session.bindExtensions({ uiContext: ui as ExtensionUIContext, mode: "print" });

  const toolByName = (name: string): PiTool => {
    const tool = session.state.tools?.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Pi has no tool named ${name}`);
    return tool;
  };

  let calls = 0;
  let closed = false;

  return {
    loadedExtensions: extensions.extensions.map((extension) => extension.path),
    toolNames: session.getAllTools().map((tool) => tool.name),
    callTool: (name, params, signal) => {
      calls += 1;
      return toolByName(name).execute(`e2e-call-${calls}`, params, signal);
    },
    runCommand: async (text) => {
      const before = notices.length;
      await session.prompt(text);
      return notices.slice(before);
    },
    // Idempotent, and each step cleans up after the one before it fails: a
    // shutdown handler that throws must not leave this process holding the
    // scenario's credentials or a stray Pi installation on disk.
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        try {
          // What Pi emits on quit — the extension closes its MCP session here.
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          session.dispose();
        }
      } finally {
        restoreEnv();
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
};
