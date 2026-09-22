/** Display formatting stays in the browser; saved source is never changed. */
import { Data, Effect, Exit, Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { applyEdits, format as jsonEdits } from "jsonc-parser";

/** The languages supported by the shared code renderer. */
export function codeLanguage(
  path: string,
): "typescript" | "javascript" | "css" | "markdown" | "html" | "json" | "shellscript" | "text" {
  if (/\.[cm]?tsx?$/.test(path)) return "typescript";
  if (/\.[cm]?jsx?$/.test(path)) return "javascript";
  if (path.endsWith(".css")) return "css";
  if (/\.(md|markdown)$/.test(path)) return "markdown";
  if (/\.html?$/.test(path)) return "html";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".sh")) return "shellscript";
  return "text";
}
class CodeFormatUnavailable extends Schema.TaggedError<CodeFormatUnavailable>()(
  "CodeFormatUnavailable",
  {},
) {}
type ScriptLanguage = "typescript" | "javascript";
const formatters = Atom.family((language: ScriptLanguage) =>
  Atom.make(
    Effect.tryPromise({
      try: () =>
        Promise.all([
          import("prettier/standalone"),
          language === "typescript"
            ? import("prettier/plugins/typescript")
            : import("prettier/plugins/babel"),
          import("prettier/plugins/estree"),
        ]).then(
          ([prettier, parser, printer]) =>
            (code: string, path: string) =>
              prettier.format(code, {
                parser: language === "typescript" ? "typescript" : "babel",
                filepath: path,
                plugins: [parser, printer],
                tabWidth: 2,
                embeddedLanguageFormatting: "off",
              }),
        ),
      catch: () => new CodeFormatUnavailable(),
    }),
  ).pipe(Atom.keepAlive),
);
const jsonSource = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
/** Edit whitespace only: parsing and reserializing could round large numeric identifiers. */
const formatJson = (code: string): string =>
  Exit.isSuccess(jsonSource(code))
    ? applyEdits(code, jsonEdits(code, undefined, { tabSize: 2, insertSpaces: true, eol: "\n" }))
    : code;
class CodeKey extends Data.Class<{ readonly code: string; readonly path: string }> {}
const formatted = Atom.family((key: CodeKey) =>
  Atom.make((get) =>
    Effect.gen(function* () {
      const language = codeLanguage(key.path);
      if (language === "json") return formatJson(key.code);
      if (language !== "typescript" && language !== "javascript") return key.code;
      const formatter = yield* get.result(formatters(language));
      return yield* Effect.tryPromise({
        try: () => formatter(key.code, key.path),
        catch: () => new CodeFormatUnavailable(),
      });
    }).pipe(Effect.catchTag("CodeFormatUnavailable", () => Effect.succeed(key.code))),
  ),
);
/** Invalid or unfinished snippets remain readable and copyable in their original form. */
export const formattedCodeAtom = (input: ConstructorParameters<typeof CodeKey>[0]) =>
  formatted(new CodeKey(input));
