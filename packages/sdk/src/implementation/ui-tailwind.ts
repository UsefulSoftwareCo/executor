/** Tailwind runs after CSS resolution and scans only code already retained for the browser. */
import { Effect } from "effect";
import { compile } from "tailwindcss";
import { initSync, WasmChangedContent, WasmScanner } from "tailwindcss-iso/oxide";
import type { UiBuildFile } from "../contracts/ui-build.ts";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";

const directives =
  /@(?:tailwind|theme|apply|utility|variant|custom-variant|config|plugin|source)\b|--(?:alpha|spacing)\(/;
const decode = (file: UiBuildFile) => new TextDecoder().decode(file.body);

/** Compile opted-in styles with one deployment's browser candidates; plain CSS is unchanged. */
export const compileUiTailwind = <E, R>(
  assets: readonly UiBuildFile[],
  html: string,
  module: Effect.Effect<WebAssembly.Module, E, R>,
) =>
  Effect.gen(function* () {
    const styles = assets.filter(
      (file) => file.contentType === "text/css" && directives.test(decode(file)),
    );
    if (styles.length === 0) return assets;
    const wasm = yield* module;
    const candidates = yield* Effect.try(() => {
      initSync({ module: wasm });
      const scanner = new WasmScanner();
      const found = new Set<string>();
      try {
        for (const source of [
          { content: html, extension: "html" },
          ...assets
            .filter((file) => file.contentType === "text/javascript")
            .map((file) => ({ content: decode(file), extension: "js" })),
        ]) {
          // The WASM method consumes ChangedContent; returned candidates need explicit release.
          const matches = scanner.getCandidatesWithPositions(
            new WasmChangedContent(source.content, source.extension),
          );
          try {
            for (const match of matches) found.add(match.candidate);
          } finally {
            for (const match of matches) match.free();
          }
        }
        return [...found];
      } finally {
        scanner.free();
      }
    });
    const compiled = new Map<string, UiBuildFile>();
    for (const file of styles) {
      const compiler = yield* Effect.tryPromise(() =>
        compile(decode(file).replace(/\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\//g, ""), {
          from: file.path,
        }),
      );
      // Builds have no host source tree. Inline safelists work; filesystem source directives do not.
      if (compiler.sources.length > 0 || (compiler.root !== null && compiler.root !== "none"))
        return yield* new RuntimeBuildFailed({ stage: "compile" });
      const css = yield* Effect.try(() =>
        compiler.build(compiler.root === "none" ? [] : candidates),
      );
      compiled.set(file.path, { ...file, body: new TextEncoder().encode(css) });
    }
    // The original CSS maps describe the pre-Tailwind output. JS maps remain untouched.
    return assets
      .filter((file) => !file.path.endsWith(".css.map") || !compiled.has(file.path.slice(0, -4)))
      .map((file) => compiled.get(file.path) ?? file);
  }).pipe(
    Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })),
    Effect.withSpan("runtime.ui.tailwind"),
  );
