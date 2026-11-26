import { Schema } from "effect";

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

export const workerModules = (modules: (typeof WorkerBundle.Type)["modules"]) =>
  Object.fromEntries(
    Object.entries(modules).map(([name, module]) => [
      name,
      typeof module === "object" && "wasm" in module
        ? { wasm: module.wasm.slice().buffer }
        : module,
    ]),
  );

const moduleSpecifier = /\b(?:from|import)\s*\(?\s*(["'])([^"'\n]+)\1/g;
const computedImport = /\bimport\s*\((?!\s*(["'])[^"'\n]+\1\s*\))/;

const resolveSpecifier = (importer: string, specifier: string) => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../"))
    return specifier.replace(/^\//, "");
  const path = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/"))
    if (part === "..") path.pop();
    else if (part !== ".") path.push(part);
  return path.join("/");
};

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

export const retireMethod = `retire() {
    if (typeof workers.abortIsolate !== "function") return false;
    workers.abortIsolate("Unloaded by the app Worker budget");
  }`;
