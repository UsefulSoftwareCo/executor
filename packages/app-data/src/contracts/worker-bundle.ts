/** Portable Worker modules. Binary bytes are base64 only at the retained JSON boundary. */
import { Schema } from "effect";

/** A compiled dependency can supply JavaScript or a statically imported WASM module. */
export const WorkerBundle = Schema.Struct({
  mainModule: Schema.NonEmptyString,
  modules: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.String,
      Schema.Struct({ js: Schema.String }),
      Schema.Struct({ wasm: Schema.Uint8ArrayFromBase64 }),
    ]),
  ),
});

/** Convert decoded bytes to the exact ArrayBuffer contract required by Worker Loader. */
export const workerModules = (modules: (typeof WorkerBundle.Type)["modules"]) =>
  Object.fromEntries(
    Object.entries(modules).map(([name, module]) => [
      name,
      typeof module === "object" && "wasm" in module
        ? { wasm: module.wasm.slice().buffer }
        : module,
    ]),
  );

/** A module specifier in an import or export statement, or a dynamic import of a literal. */
const moduleSpecifier = /\b(?:from|import)\s*\(?\s*(["'])([^"'\n]+)\1/g;
/** A dynamic import of a computed specifier, which could load any module. */
const computedImport = /\bimport\s*\((?!\s*(["'])[^"'\n]+\1\s*\))/;

/** The module a specifier names, relative to the importing module; Worker module names have no leading slash. */
const resolveSpecifier = (importer: string, specifier: string) => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../"))
    return specifier.replace(/^\//, "");
  const path = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/"))
    if (part === "..") path.pop();
    else if (part !== ".") path.push(part);
  return path.join("/");
};

/**
 * The modules a Worker can load from `main`: those reached by import and export statements and by
 * dynamic imports of literal specifiers. The Worker Loader compiles every module it receives when
 * an isolate starts, imported or not, so a build's unused framework entry points (the MCP client
 * in an OpenAPI app, for instance) would add to every cold start. A module that imports a computed
 * specifier could load any module, so then every module is kept.
 */
export const reachableModules = <Module>(
  main: string,
  modules: Readonly<Record<string, Module>>,
): Record<string, Module> => {
  const source = (module: Module) =>
    typeof module === "string"
      ? module
      : typeof module === "object" &&
          module !== null &&
          "js" in module &&
          typeof module.js === "string"
        ? module.js
        : undefined;
  const reached = new Set<string>();
  const pending = [main];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name) || !Object.hasOwn(modules, name)) continue;
    reached.add(name);
    const code = source(modules[name]!);
    if (code === undefined) continue;
    if (computedImport.test(code)) return { ...modules };
    for (const [, , specifier] of code.matchAll(moduleSpecifier))
      pending.push(resolveSpecifier(name, specifier!));
  }
  return Object.fromEntries(Object.entries(modules).filter(([name]) => reached.has(name)));
};

/**
 * The method every runtime-owned Worker entrypoint exports so its host can unload it. The pinned
 * workerd keeps each named Worker Loader entry for the life of the process; only `abortIsolate`,
 * run inside the loaded Worker, removes the entry and lets the isolate go. It stops the isolate's
 * execution, so its caller sees an internal error rather than a result. A runtime without it
 * returns false and keeps the Worker.
 */
export const retireMethod = `retire() {
    if (typeof workers.abortIsolate !== "function") return false;
    workers.abortIsolate("Unloaded by the app Worker budget");
  }`;
