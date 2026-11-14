/**
 * Write the licence notices of the code the build bundles into its output: `licenses/<package>/`
 * holds each bundled package's licence and notice files, and `runtime-packages.txt` lists those
 * packages. The layout and file-name pattern are the release's own (`scripts/releases/runtime-bundle.ts`),
 * so a release can merge the two.
 *
 * The packages come from what the bundler included: the modules of every emitted chunk, and the
 * files Tailwind read to generate the stylesheet, which never enter the module graph. The viewer's
 * own source is the `@executor-js/telemetry-viewer` package, whose `LICENSE` is Motel's MIT notice.
 * The build fails when an included package has no licence file of its own (`licenceFile`); a
 * notice that only covers code the package took from others does not count.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin, PluginOption } from "vite";

/** Files copied beside a package's licence: the release's pattern, notices included. */
const noticeFile = /^(licen[sc]e|notice|copying|copyright|third.party)([._-]|$)/iu;

/**
 * The package's own licence: `LICENSE`, `LICENCE` or `COPYING`, optionally with one licence
 * suffix such as `-MIT`, and optionally `.md`, `.txt`, `.markdown` or `.rst`. `NOTICE`,
 * `COPYRIGHT` and `THIRD_PARTY_NOTICES` files do not qualify.
 */
const licenceFile = /^(licen[sc]e|copying)(-[a-z0-9.]+)?(\.(md|txt|markdown|rst))?$/iu;

const readManifest = (directory: string): { readonly name?: string; readonly version?: string } =>
  JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));

/** The directory of the package that owns `file`. */
const packageDirectory = (file: string): string => {
  const boundary = file.lastIndexOf("/node_modules/");
  if (boundary >= 0) {
    const parts = file.slice(boundary + "/node_modules/".length).split("/");
    return path.join(
      file.slice(0, boundary),
      "node_modules",
      ...parts.slice(0, parts[0]?.startsWith("@") ? 2 : 1),
    );
  }
  // Outside node_modules: the nearest enclosing package with a name, that is, a workspace package.
  let directory = path.dirname(file);
  while (true) {
    try {
      if (readManifest(directory).name !== undefined) return directory;
    } catch {
      // No package.json here; keep looking upwards.
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`No package owns ${file}`);
    directory = parent;
  }
};

/** The record of what a build bundled, and the plugins that collect and write it. */
export const licenseNotices = (root: string) => {
  const stylesheetSources = new Set<string>();
  // The bundler's runtime helpers (`\0rolldown/runtime.js`, `\0vite/preload-helper.js`) are Vite
  // and Rolldown code. This Vite distribution's licence covers both.
  const bundlerPackage = path.dirname(
    realpathSync(createRequire(path.join(root, "package.json")).resolve("vite/package.json")),
  );

  const ownerOf = (id: string): string => {
    if (id.startsWith("\0")) {
      if (/^\0(vite|rolldown)\//u.test(id)) return bundlerPackage;
      throw new Error(
        `The bundle includes the virtual module ${id.slice(1)}, whose owner is unknown`,
      );
    }
    return packageDirectory(realpathSync(id.replace(/\?.*$/u, "")));
  };

  /**
   * Record the files a stylesheet plugin reads. Tailwind reports them with `addWatchFile`, the
   * only place they are visible to the build.
   */
  const recordingStylesheetSources = (option: PluginOption): PluginOption => {
    if (Array.isArray(option)) return option.map(recordingStylesheetSources);
    if (option === null || typeof option !== "object" || !("name" in option)) return option;
    const plugin: Plugin = option;
    const transform = plugin.transform;
    if (transform === undefined) return plugin;
    const handler = typeof transform === "function" ? transform : transform.handler;
    const recorded: typeof handler = function (this, ...args) {
      const addWatchFile = (file: string) => {
        stylesheetSources.add(file);
        this.addWatchFile(file);
      };
      // The context's members read private state, so they run against the real context.
      const context = new Proxy(this, {
        get: (target, property) => {
          if (property === "addWatchFile") return addWatchFile;
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return handler.apply(context, args);
    };
    return {
      ...plugin,
      transform: typeof transform === "function" ? recorded : { ...transform, handler: recorded },
    };
  };

  const write: Plugin = {
    name: "executor-license-notices",
    apply: "build",
    generateBundle(_options, bundle) {
      const packages = new Set<string>();
      for (const output of Object.values(bundle))
        if (output.type === "chunk") for (const id of output.moduleIds) packages.add(ownerOf(id));
      // Tailwind also reports the globs it scans for class names. They are patterns, not files,
      // and put no code in the stylesheet.
      for (const file of stylesheetSources)
        if (statSync(file, { throwIfNoEntry: false })?.isFile()) packages.add(ownerOf(file));

      const inventory = new Set<string>();
      for (const directory of packages) {
        const pkg = readManifest(directory);
        const identity = `${pkg.name}@${pkg.version ?? "workspace"}`;
        if (inventory.has(identity)) continue;
        inventory.add(identity);
        const notices = readdirSync(directory).filter((name) => noticeFile.test(name));
        const licences = notices.filter((name) => {
          if (!licenceFile.test(name)) return false;
          const info = statSync(path.join(directory, name), { throwIfNoEntry: false });
          return info !== undefined && info.isFile() && info.size > 0;
        });
        if (licences.length === 0)
          this.error(
            `${identity} (${directory}) is in the bundle but has no licence file of its own: ` +
              `a non-empty LICENSE, LICENCE or COPYING file` +
              (notices.length === 0 ? "" : ` (found: ${notices.join(", ")})`),
          );
        for (const name of notices)
          this.emitFile({
            type: "asset",
            fileName: `licenses/${identity.replaceAll("/", "__")}/${name}`,
            source: readFileSync(path.join(directory, name)),
          });
      }
      this.emitFile({
        type: "asset",
        fileName: "runtime-packages.txt",
        source: [...inventory].sort().join("\n") + "\n",
      });
    },
  };

  return { recordingStylesheetSources, write };
};
