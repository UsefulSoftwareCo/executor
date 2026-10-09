/**
 * Place a failure in a freshly compiled server bundle at the authored source that caused it. The
 * map lives only for the build that produced it: it is not retained, and it holds no source text.
 */
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import type { Plugin } from "esbuild";
import { Schema } from "effect";
import { DatabaseFieldReserved } from "apps/contracts";
import type { SourceFiles, SourceLocation } from "../contracts/deployment.ts";
import { boundBuildMessage, describeBuildCause, RuntimeBuildFailed } from "../contracts/runtime.ts";

/** The bundler reads source from its `virtual:` namespace; report the authored path. */
const sourcePath = (file: string) => file.replace(/^virtual:/, "");

const utf8 = new TextEncoder();
/** Keeps a leading byte order mark, so every code unit before the column is counted. */
const utf16 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Enter an esbuild message's location into Executor's `SourceLocation`, which counts columns from
 * 1 in UTF-16 code units. esbuild counts them from 0 in UTF-8 bytes of `lineText`, so text before
 * the column that is not ASCII would otherwise move it right.
 */
export const sourceLocation = (location: {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly lineText: string;
}) =>
  ({
    file: sourcePath(location.file),
    line: location.line,
    column: utf16.decode(utf8.encode(location.lineText).subarray(0, location.column)).length + 1,
  }) satisfies SourceLocation;

/** Enter a source-map position. Source maps count columns from 0 in UTF-16 code units, as V8 does. */
const mappedLocation = (position: {
  readonly source: string;
  readonly line: number;
  readonly column: number;
}) =>
  ({
    file: sourcePath(position.source),
    line: position.line,
    column: position.column + 1,
  }) satisfies SourceLocation;

/**
 * Map the server entry's bundle. esbuild returns the map as an output file before the bundle, and
 * worker-bundler keeps only the first output, so the map is taken out of the result.
 */
export const serverSourceMap = (entry: string) => {
  let map: string | undefined;
  const plugin: Plugin = {
    name: "executor-server-source-map",
    setup(build) {
      const entries = build.initialOptions.entryPoints;
      if (!Array.isArray(entries) || entries[0] !== entry) return;
      Object.assign(build.initialOptions, { sourcemap: "external", sourcesContent: false });
      build.onEnd((result) => {
        const outputs = result.outputFiles ?? [];
        const index = outputs.findIndex((file) => file.path.endsWith(".map"));
        if (index === -1) return;
        map = outputs[index]?.text;
        outputs.splice(index, 1);
      });
    },
  };
  return { plugin, map: () => map };
};

/** A V8 stack position, `module:line:column`, with a 1-based column. */
const stackPosition = /([\w./@-]+):(\d+):(\d+)/g;

/**
 * The declaration failure of a build compiled with `sourceMap`. A Worker that fails while its
 * modules load reports stack positions in the bundle; each becomes the authored file and position
 * it came from, and the first in a deployed source file is the location.
 */
export const declarationFailed = (
  cause: unknown,
  build: { readonly mainModule: string; readonly sourceMap: string; readonly files: SourceFiles },
) => {
  const described = describeBuildCause(cause);
  let map: TraceMap | undefined;
  let location: SourceLocation | undefined;
  const message = described.replace(stackPosition, (text, module, line, column) => {
    if (module !== build.mainModule) return text;
    map ??= new TraceMap(build.sourceMap);
    const original = originalPositionFor(map, { line: Number(line), column: Number(column) - 1 });
    if (original.source === null) return text;
    const authored = mappedLocation({
      source: original.source,
      line: original.line,
      column: original.column,
    });
    if (location === undefined && build.files.some((source) => source.path === authored.file))
      location = authored;
    return `${authored.file}:${authored.line}:${authored.column}`;
  });
  return new RuntimeBuildFailed({
    stage: "declaration",
    message: boundBuildMessage(message),
    ...(location === undefined ? {} : { location }),
    ...(Schema.is(DatabaseFieldReserved)(cause) ? { declaration: cause } : {}),
  });
};
