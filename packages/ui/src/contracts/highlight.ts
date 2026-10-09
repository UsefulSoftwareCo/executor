import { Schema } from "effect";
/** Syntax highlighting can fail without preventing source inspection. */
export class HighlightUnavailable extends Schema.TaggedError<HighlightUnavailable>()(
  "HighlightUnavailable",
  {},
) {}
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { HighlighterCore } from "shiki/core";

/** One shared Shiki instance for every code view, loaded on first use. */
export const highlighterAtom = Atom.make(
  Effect.tryPromise({
    try: () => import("../implementation/highlight-engine.ts"),
    catch: () => new HighlightUnavailable({}),
  }).pipe(Effect.flatMap((module) => module.highlighter)),
).pipe(Atom.keepAlive);

/** Syntax tokens are plain text, never executable HTML from app source. */
export const highlightedAtom = Atom.family(
  (input: { readonly code: string; readonly language: string }) =>
    Atom.make((get) =>
      Effect.gen(function* () {
        const highlighter = yield* get.result(highlighterAtom);
        return highlightTokens(highlighter, input.code, input.language);
      }),
    ),
);

/** Tokenize with both themes; each token carries its light color and a `--shiki-dark` variable. */
export function highlightTokens(
  highlighter: Pick<HighlighterCore, "codeToTokens">,
  code: string,
  language: string,
) {
  return highlighter.codeToTokens(code, {
    lang: language,
    themes: { light: "github-light", dark: "github-dark" },
  }).tokens;
}
