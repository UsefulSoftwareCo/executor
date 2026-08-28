// Rendering for changelog bodies.
//
// CHANGELOG.md is generated from changesets, and a changeset is written by
// whoever opened the pull request. Its text is therefore untrusted input that
// happens to live in the repository, and markdown allows both raw HTML and
// `javascript:` links. Every path that turns a body into HTML goes through
// `renderChangelogHtml`, which parses the markdown and then re-serializes it
// through a fixed allowlist, so anything outside that list cannot survive —
// no `<script>`, no event handlers, no non-https URLs.
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

// Prose only. A changelog entry never needs images, tables, iframes, styles or
// ids, so none of them are allowed. Unlisted tags are dropped but their text is
// kept, and `sanitize-html` discards the contents of `script`/`style` outright.
const RENDER_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "h3", "h4", "a"],
  allowedAttributes: { a: ["href", "rel", "target"] },
  // https only: this also rules out `javascript:`, `data:` and protocol-relative
  // URLs, which `marked` itself does not filter.
  allowedSchemes: ["https"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: "noopener noreferrer", target: "_blank" },
    }),
  },
};

const TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: "discard",
};

const toHtml = (body: string): string => marked.parse(body, { async: false });

/** Sanitized HTML for a changelog entry body, safe to inject with `set:html`. */
export const renderChangelogHtml = (body: string): string =>
  sanitizeHtml(toHtml(body), RENDER_OPTIONS);

// `sanitize-html` escapes the text it emits, because its output is HTML, and
// `&amp;` in a JSON string is just noise. `&lt;` and `&gt;` are deliberately
// left escaped: a body may legitimately contain `<` (a code span such as
// `` `<origin>/mcp` ``), and decoding it would put a live tag back into a
// payload whose whole point is that it carries none.
const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  // Last, so that a literal `&quot;` in the source (encoded as `&amp;quot;`)
  // decodes back to `&quot;` rather than to a quote character.
  [/&amp;/g, "&"],
];

/**
 * A changelog entry body as plain text, with every tag removed.
 *
 * `/changelog.json` is public and cross-origin readable, so it must not hand a
 * consumer markup it would be unsafe to render. The body is rendered and then
 * stripped rather than regex-scrubbed, so markdown constructs (code spans,
 * links, emphasis) collapse to their text instead of leaking their syntax.
 */
export const changelogBodyToText = (body: string): string => {
  const stripped = sanitizeHtml(toHtml(body), TEXT_OPTIONS);
  const decoded = ENTITIES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    stripped,
  );
  return decoded
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};
