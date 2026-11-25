import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import type { Plugin } from "esbuild";
import { Schema } from "effect";
import { DatabaseFieldReserved } from "apps/contracts";
import type { SourceFiles, SourceLocation } from "../contracts/version.ts";
import { boundBuildMessage, describeBuildCause, RuntimeBuildFailed } from "../contracts/runtime.ts";

const sourcePath = (file: string) => file.replace(/^virtual:/, "");

const utf8 = new TextEncoder();
const utf16 = new TextDecoder("utf-8", { ignoreBOM: true });

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

const stackPosition = /([\w./@-]+):(\d+):(\d+)/g;

export const declarationFailed = (
  cause: unknown,
  build: { readonly mainModule: string; readonly sourceMap: string; readonly files: SourceFiles },
  unanswered?: true,
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
    ...(unanswered === undefined ? {} : { unanswered }),
  });
};
