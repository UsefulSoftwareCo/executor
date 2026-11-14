/**
 * Markdown people read while connecting an account: an app's setup help. The connect form renders
 * it without raw HTML or images, and links only https addresses.
 */
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { Schema, type Effect } from "effect";

/** What one piece of Markdown holds that the connect form would not show as written. */
export const MarkdownRefusals = Schema.Struct({
  html: Schema.Boolean,
  image: Schema.Boolean,
  /** Each link or link definition address that is not an absolute https URL. */
  links: Schema.Array(Schema.String),
});
export type MarkdownRefusals = typeof MarkdownRefusals.Type;

/**
 * The host could not read the Markdown, so it was not judged. Help is never saved unchecked: the
 * deploy fails, and repeating it can succeed.
 */
export const MarkdownUnavailable = UserFacingError.define({
  tag: "MarkdownUnavailable",
  status: 503,
  title: "Markdown check unavailable",
  description:
    "Executor could not check the setup help for the raw HTML, images and links it refuses. It never saves help unchecked, so nothing changed.",
  recovery: {
    action: "Try again in a moment.",
    instructions:
      "Executor’s own Markdown check did not answer, so the Markdown was not judged and may be fine. Repeat the same deploy once. If it fails again, report it as an Executor service problem instead of retrying further. Do not remove an app’s setup help to get a deploy through.",
  },
  retryable: true,
  agentFixable: false,
});
export type MarkdownUnavailable = typeof MarkdownUnavailable.Type;

/**
 * Read pieces of authored Markdown for what the connect form would not show, answering each text
 * in order. A deploy reads all its setup help at once, and with none it does not call the reader.
 * `markdownRefusals` from `@executor-js/sdk/markdown` parses in process, with GFM as the form does.
 * A host passes it in, so a Worker can parse in another Worker instead of uploading the parser; a
 * read that fails is `MarkdownUnavailable`.
 */
export type MarkdownReader = (
  texts: ReadonlyArray<string>,
) => Effect.Effect<ReadonlyArray<MarkdownRefusals>, MarkdownUnavailable>;
