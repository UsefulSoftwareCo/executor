import { HighlightUnavailable } from "../contracts/highlight.ts";
import { Effect } from "effect";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import typescript from "shiki/langs/typescript.mjs";
import javascript from "shiki/langs/javascript.mjs";
import css from "shiki/langs/css.mjs";
import markdown from "shiki/langs/markdown.mjs";
import html from "shiki/langs/html.mjs";
import json from "shiki/langs/json.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import light from "shiki/themes/github-light.mjs";
import dark from "shiki/themes/github-dark.mjs";

/** Lazily acquire only the grammars used by source and schema views; dispose with the Atom registry. */
export const highlighter = Effect.acquireRelease(
  Effect.tryPromise({
    try: () =>
      createHighlighterCore({
        themes: [light, dark],
        langs: [typescript, javascript, css, markdown, html, json, shellscript],
        engine: createJavaScriptRegexEngine(),
      }),
    catch: () => new HighlightUnavailable({}),
  }),
  (value) => Effect.sync(() => value.dispose()),
);
