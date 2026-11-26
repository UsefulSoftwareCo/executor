import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin, PluginOption } from "vite";

const noticeFile = /^(licen[sc]e|notice|copying|copyright|third.party)([._-]|$)/iu;

const licenceFile = /^(licen[sc]e|copying)(-[a-z0-9.]+)?(\.(md|txt|markdown|rst))?$/iu;

const readManifest = (directory: string): { readonly name?: string; readonly version?: string } =>
  JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));

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
  let directory = path.dirname(file);
  while (true) {
    try {
      if (readManifest(directory).name !== undefined) return directory;
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`No package owns ${file}`);
    directory = parent;
  }
};

export const licenseNotices = (root: string) => {
  const stylesheetSources = new Set<string>();
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
