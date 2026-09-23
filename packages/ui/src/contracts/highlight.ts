import { Schema } from "effect";
/** Syntax highlighting can fail without preventing source inspection. */
export class HighlightUnavailable extends Schema.TaggedError<HighlightUnavailable>()(
  "HighlightUnavailable",
  {},
) {}
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";

const highlighterAtom = Atom.make(
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
        return highlighter.codeToTokens(input.code, {
          lang: input.language,
          themes: { light: "github-light", dark: "github-dark" },
        }).tokens;
      }),
    ),
);
