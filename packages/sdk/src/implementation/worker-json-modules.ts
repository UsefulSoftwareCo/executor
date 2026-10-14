/**
 * Authored JSON imports as Worker modules of their own, which parse the file's text when the
 * Worker loads them. The compiler never parses the JSON: printing a large document, such as an
 * OpenAPI app's, as JavaScript needs many times its size in compiler memory.
 */
import type { Plugin } from "esbuild";
import type { SourceTextFile } from "../contracts/source.ts";
import type { SourceLocation } from "../contracts/deployment.ts";
import { boundBuildMessage, RuntimeBuildFailed } from "../contracts/runtime.ts";
import { serverFiles, serverFilesModule } from "./worker-bridge.ts";

const space = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;
const digit = (code: number) => code >= 48 && code <= 57;
const hex = (code: number) =>
  digit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
/** The characters `JSON.parse` accepts after a backslash, other than `u`. */
const escapes = new Set([34, 47, 92, 98, 102, 110, 114, 116]);

/**
 * The offset of the first character `JSON.parse` would reject, or undefined when it accepts the
 * text. Unlike `JSON.parse`, this builds no values, so checking a large document costs no memory.
 */
const invalidOffset = (text: string): number | undefined => {
  const end = text.length;
  let at = 0;
  const skipSpace = () => {
    while (at < end && space(text.charCodeAt(at))) at++;
  };
  const string = () => {
    if (text.charCodeAt(at) !== 34) return false;
    at++;
    while (at < end) {
      const code = text.charCodeAt(at);
      if (code === 34) {
        at++;
        return true;
      }
      if (code < 32) return false;
      at++;
      if (code !== 92) continue;
      const escape = text.charCodeAt(at);
      if (escape === 117) {
        for (let count = 0; count < 4; count++, at++)
          if (!hex(text.charCodeAt(at + 1))) return false;
        at++;
      } else if (escapes.has(escape)) at++;
      else return false;
    }
    return false;
  };
  const digits = () => {
    const start = at;
    while (at < end && digit(text.charCodeAt(at))) at++;
    return at > start;
  };
  const number = () => {
    if (text.charCodeAt(at) === 45) at++;
    if (text.charCodeAt(at) === 48) at++;
    else if (!digits()) return false;
    if (text.charCodeAt(at) === 46) {
      at++;
      if (!digits()) return false;
    }
    const exponent = text.charCodeAt(at);
    if (exponent === 101 || exponent === 69) {
      at++;
      const sign = text.charCodeAt(at);
      if (sign === 43 || sign === 45) at++;
      if (!digits()) return false;
    }
    return true;
  };
  const word = (literal: string) => {
    if (!text.startsWith(literal, at)) return false;
    at += literal.length;
    return true;
  };
  /** A member's name and colon; the value follows. */
  const member = () => {
    skipSpace();
    if (!string()) return false;
    skipSpace();
    if (text.charCodeAt(at) !== 58) return false;
    at++;
    return true;
  };
  // The open objects (123) and arrays (91), innermost last.
  const open: number[] = [];
  for (;;) {
    skipSpace();
    const code = text.charCodeAt(at);
    if (code === 123 || code === 91) {
      at++;
      skipSpace();
      if (text.charCodeAt(at) === code + 2) at++;
      else {
        open.push(code);
        if (code === 123 && !member()) return at;
        continue;
      }
    } else if (code === 34) {
      if (!string()) return at;
    } else if (code === 45 || digit(code)) {
      if (!number()) return at;
    } else if (!word("true") && !word("false") && !word("null")) return at;
    // A value ended: close the containers it ends, then read the next member or element.
    for (;;) {
      skipSpace();
      const container = open.at(-1);
      if (container === undefined) return at === end ? undefined : at;
      const next = text.charCodeAt(at);
      if (next === container + 2) {
        at++;
        open.pop();
        continue;
      }
      if (next !== 44) return at;
      at++;
      if (container === 123 && !member()) return at;
      break;
    }
  }
};

/** The line and column, from 1 and in UTF-16 code units, of an offset in a file. */
const locate = (file: string, text: string, offset: number) => {
  let line = 1;
  let start = 0;
  for (let at = text.indexOf("\n"); at !== -1 && at < offset; at = text.indexOf("\n", at + 1)) {
    line++;
    start = at + 1;
  }
  return { file, line, column: offset - start + 1 } satisfies SourceLocation;
};

/**
 * Applies to the server build. Each JSON source file an authored module imports becomes a module
 * whose default export is the parsed file, as a JSON module's is. A file `ctx.files` holds is
 * parsed from there, so the build keeps one copy of its text. Dependencies' own JSON files are
 * bundled as before.
 */
export const jsonModules = (files: readonly SourceTextFile[], entry: string) => {
  const retained = serverFiles(files);
  const modules: Record<string, string> = {};
  const names = new Map<string, string>();
  let failure: RuntimeBuildFailed | undefined;
  const plugin: Plugin = {
    name: "executor-json-modules",
    setup(build) {
      const entries = build.initialOptions.entryPoints;
      if (!Array.isArray(entries) || entries[0] !== entry) return;
      // Only the entry imports the files module, and only a JSON file's stand-in its module, so an
      // authored file of the same name still resolves to itself.
      build.onResolve({ filter: /^\.\/__executor_/ }, (args) =>
        (args.importer === entry && args.path === `./${serverFilesModule}`) ||
        names.get(args.importer) === args.path.slice(2)
          ? { path: args.path, external: true }
          : undefined,
      );
      build.onLoad({ filter: /\.json$/, namespace: "virtual" }, (args) => {
        if (args.path.startsWith("node_modules/")) return undefined;
        const index = retained.findIndex((file) => file.path === args.path);
        const text =
          retained[index]?.content ?? files.find((file) => file.path === args.path)?.content;
        if (text === undefined) return undefined;
        const offset = invalidOffset(text);
        if (offset !== undefined) {
          const location = locate(args.path, text, offset);
          const message = boundBuildMessage(
            `${location.file}:${location.line}:${location.column}: ${offset === text.length ? "Unexpected end of JSON" : "Invalid JSON"}`,
          );
          failure = new RuntimeBuildFailed({ stage: "compile", message, location });
          return { errors: [{ text: message }] };
        }
        let name = names.get(args.path);
        if (name === undefined) {
          name = `__executor_json_${names.size}.js`;
          names.set(args.path, name);
          modules[name] =
            index === -1
              ? `export default JSON.parse(${JSON.stringify(text)});`
              : `import files from "./${serverFilesModule}";\nexport default JSON.parse(files[${index}].content);`;
        }
        return { contents: `export { default } from "./${name}";`, loader: "js", resolveDir: "" };
      });
    },
  };
  return { modules, plugin, failure: () => failure };
};
