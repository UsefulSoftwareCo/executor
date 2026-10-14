/**
 * Start the local CLI with a stand-in for one package it loads at runtime, such as the OS
 * credential store binding, so a scenario never touches this machine's real store.
 *
 * A script entry runs under Node with a loader hook that resolves the package to the stand-in. A
 * release executable runs no loader hooks or preloads, but loads such packages from
 * `runtime/node_modules` beside it. It gets a copy of its install that shares every file except
 * that package: the executable is linked, everything else points back at the install.
 */
import { Effect, FileSystem, Path } from "effect";
import { isScript } from "./local-entry.ts";

/** How to start the CLI: run `command` with `prefix` before the CLI's own arguments. */
export interface StandInLaunch {
  readonly command: string;
  readonly prefix: ReadonlyArray<string>;
}

/**
 * `source` is the stand-in's ES module. With `activeWhen`, the stand-in replaces the package only
 * in a process where that environment variable is set; other starts load the real package.
 * Scripts and the shadow install live under `root`, which the caller removes.
 */
export const withStandInPackage = (
  entry: string,
  root: string,
  name: "@napi-rs/keyring",
  source: string,
  activeWhen?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (isScript(entry)) {
      yield* fs.writeFileString(path.join(root, "stand-in.mjs"), source);
      yield* fs.writeFileString(
        path.join(root, "hooks.mjs"),
        [
          'const standIn = new URL("./stand-in.mjs", import.meta.url).href;',
          "export async function resolve(specifier, context, next) {",
          `  if (specifier === ${JSON.stringify(name)}${activeWhen === undefined ? "" : ` && process.env[${JSON.stringify(activeWhen)}]`})`,
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
      const register = (yield* path.toFileUrl(path.join(root, "register.mjs"))).href;
      return { command: "node", prefix: ["--import", register, entry] } satisfies StandInLaunch;
    }
    const executable = yield* shadowInstall(entry, path.join(root, "install"), {
      name,
      source,
      activeWhen,
    });
    return { command: executable, prefix: [] } satisfies StandInLaunch;
  });

/**
 * Give a release executable a second install at `shadow` that shares every file with the first:
 * the executable is linked, as it finds its install from its own real path, and everything else
 * points back at the original. With `standIn`, that one package under runtime/node_modules is the
 * stand-in module instead. Returns the shadow executable.
 */
export const shadowInstall = (
  entry: string,
  shadow: string,
  standIn?: {
    readonly name: "@napi-rs/keyring";
    readonly source: string;
    readonly activeWhen?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const windows = process.platform === "win32";
    const install = path.dirname(yield* fs.realPath(entry));
    const name = path.basename(entry);
    yield* fs.makeDirectory(shadow, { recursive: true });
    /** Point `destination` at `source`. Windows copies files, as file links need privileges. */
    const share = (source: string, destination: string) =>
      Effect.gen(function* () {
        if (windows && (yield* fs.stat(source)).type !== "Directory")
          return yield* fs.copyFile(source, destination);
        yield* fs.symlink(source, destination);
      });
    const executable = path.join(shadow, name);
    // A hard link shares the executable's bytes; a copy is the fallback across volumes.
    yield* fs
      .link(path.join(install, name), executable)
      .pipe(Effect.catch(() => fs.copyFile(path.join(install, name), executable)));
    for (const item of yield* fs.readDirectory(install))
      if (item !== name && (standIn === undefined || item !== "runtime"))
        yield* share(path.join(install, item), path.join(shadow, item));
    if (standIn === undefined) return executable;
    const runtime = path.join(install, "runtime");
    yield* fs.makeDirectory(path.join(shadow, "runtime"));
    for (const item of yield* fs.readDirectory(runtime))
      if (item !== "node_modules")
        yield* share(path.join(runtime, item), path.join(shadow, "runtime", item));
    const scope = standIn.name.slice(0, standIn.name.indexOf("/"));
    const base = standIn.name.slice(standIn.name.indexOf("/") + 1);
    const modules = path.join(runtime, "node_modules");
    const shadowModules = path.join(shadow, "runtime", "node_modules");
    yield* fs.makeDirectory(path.join(shadowModules, scope), { recursive: true });
    for (const item of yield* fs.readDirectory(modules))
      if (item !== scope) yield* share(path.join(modules, item), path.join(shadowModules, item));
    for (const item of yield* fs.readDirectory(path.join(modules, scope)))
      if (item !== base)
        yield* share(path.join(modules, scope, item), path.join(shadowModules, scope, item));
    const module = path.join(shadowModules, scope, base);
    yield* fs.makeDirectory(module);
    yield* fs.writeFileString(path.join(module, "stand-in.mjs"), standIn.source);
    // Without its variable, the module is the real package from the original install.
    yield* fs.writeFileString(
      path.join(module, "index.mjs"),
      standIn.activeWhen === undefined
        ? 'export * from "./stand-in.mjs";\n'
        : [
            'import { createRequire } from "node:module";',
            'import * as standIn from "./stand-in.mjs";',
            `const active = Boolean(process.env[${JSON.stringify(standIn.activeWhen)}]);`,
            `const real = active ? undefined : createRequire(${JSON.stringify(path.join(runtime, "cli.mjs"))})(${JSON.stringify(standIn.name)});`,
            "export const AsyncEntry = active ? standIn.AsyncEntry : real.AsyncEntry;",
            "",
          ].join("\n"),
    );
    yield* fs.writeFileString(
      path.join(module, "package.json"),
      JSON.stringify({ name: standIn.name, type: "module", exports: "./index.mjs" }),
    );
    return executable;
  });
