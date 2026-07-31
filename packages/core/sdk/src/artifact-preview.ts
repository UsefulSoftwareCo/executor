// ---------------------------------------------------------------------------
// The artifact layout preview — what the gallery shows instead of a schematic.
//
// An artifact's create-time smoke render already drives a full server render of
// the real component with a transport that never settles, so every query stays
// pending and the component renders its LOADING state. That render's markup is
// the artifact's true composition — its cards, tables, chart frames and
// skeletons — with no data in it. This module is the contract for storing it.
//
// ## Why this is safe to store, and safe to insert
//
// Two properties do the work, and neither is a matter of trust in the model:
//
//   1. It carries no live data. The harness's transport is `neverSettles`, so
//      no tool ran, nothing was fetched, and no row of anybody's reached the
//      renderer. Everything in the markup came from the artifact's own source.
//      That is why this is ordinary artifact metadata rather than per-viewer
//      state, and why it stays correct as the shareable preview when org-tier
//      sharing lands — see `ArtifactPreviewImage` for the half that does NOT.
//
//   2. It cannot execute. React's server renderer escapes every text node and
//      attribute value it writes; it does not emit `<script>` for a component
//      tree, and event handlers become nothing at all (there is no `onClick`
//      attribute in SSR output — handlers are attached by hydration, which
//      never happens here). So the markup is already inert by construction.
//
// `sanitizeArtifactPreviewMarkup` does NOT rely on either property. It is a
// second, independent gate applied at the trust boundary, written against an
// allowlist rather than a blocklist: only known-inert elements and attributes
// survive, everything else is dropped. Defense in depth is the point — property
// (2) is a fact about today's React, and a sanitizer that only holds while that
// stays true is not a sanitizer.
// ---------------------------------------------------------------------------

/**
 * The cap on stored preview markup.
 *
 * The sandbox harness caps what it KEEPS at 128 KiB; this is the second gate,
 * applied after sanitizing, on the value that actually reaches a row.
 *
 * It is much tighter than the harness's cap because of where this value is
 * read: the preview is part of the artifact SUMMARY, so every row of it is
 * fetched on every visit to the gallery. A measured render of a four-card,
 * five-row dashboard sanitizes to about 7 KiB, so 32 KiB is several times the
 * realistic ceiling while keeping a full grid comfortably under a megabyte.
 * Past it, nothing is stored and the card falls back to its schematic — a
 * preview is a nicety, and a list that loads slowly to get one is a bad trade.
 */
export const ARTIFACT_PREVIEW_MARKUP_LIMIT = 32 * 1024;

/**
 * Elements that may appear in a preview.
 *
 * Structure, text and tables only. Deliberately absent, each for its own
 * reason rather than as a blanket: `script`/`style` execute or restyle the
 * host; `iframe`/`object`/`embed`/`link` fetch; `img`/`video`/`audio`/`source`
 * fetch and are a tracking beacon even when they fail; `form`/`input`/`button`
 * are interactive, and this preview is inert by contract; `a` navigates.
 * `svg` earns its place — every chart and icon in the component barrel is one —
 * but only through the geometry-only subset below.
 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "nav",
  "figure",
  "figcaption",
  "hr",
  "br",
  "small",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "code",
  "pre",
  "kbd",
  "samp",
  "blockquote",
  "label",
  "time",
  "abbr",
  // SVG: the geometry the chart and icon libraries emit. No `image`,
  // `foreignObject`, `use` or `script` — each of those is either a fetch or an
  // escape back into HTML.
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "clippath",
  "lineargradient",
  "radialgradient",
  "stop",
  "mask",
  "pattern",
  "title",
  "desc",
]);

/**
 * Attributes that may survive on any element.
 *
 * `class` is what makes the preview look like the artifact at all — the shell's
 * Tailwind classes are the entire visual layer. `style` is here too, but only
 * through {@link sanitizeStyle}, which keeps a narrow set of layout properties
 * and no value that can fetch: skeleton widths are written inline
 * (`style="width:92%"`), and they are the loading state's whole visual
 * signature.
 */
const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  "class",
  "style",
  "colspan",
  "rowspan",
  "dir",
  "lang",
  "role",
  "datetime",
  "start",
  "reversed",
  "value",
  // SVG geometry and paint. Everything here is a number, a length, a colour or
  // a local `url(#id)` reference; none of them fetch.
  "viewbox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "transform",
  "opacity",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "patternunits",
  "clip-path",
  "clip-rule",
  "mask",
  "text-anchor",
  "dominant-baseline",
  "font-size",
  "font-weight",
  "font-family",
  "preserveaspectratio",
  "xmlns",
]);

/** Elements written as `<tag />` with no closing tag. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "br",
  "hr",
  "col",
  "img",
  "input",
  "source",
  "embed",
  "link",
  "meta",
]);

/**
 * Elements whose CONTENT is dropped along with them.
 *
 * For everything else, removing a tag keeps its children — a `<button>`'s label
 * is still part of the composition. But the body of a `<script>` or `<style>`
 * is code, and unwrapping it would paste that code into the document as text
 * that a later parse could resurrect. These are cut whole.
 */
const CONTENT_BEARING_REMOVALS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "object",
  "embed",
]);

/** `id` and `for`-style references are namespaced so a preview cannot collide
 *  with, or capture, an id in the console document that hosts it. */
const PREVIEW_ID_PREFIX = "artifact-preview-";

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode the entities React's renderer wrote, so escaping can round-trip.
 *
 * The input is ALREADY-escaped HTML: React writes `&` as `&amp;`. Escaping that
 * again yields `&amp;amp;`, which is not a security improvement but is a
 * correctness bug with teeth — Tailwind's arbitrary variants are full of `&`
 * (`[&_.recharts-layer]:outline-hidden`), and double-escaping mangles every one
 * of them, so the preview loses the styling that makes it look like the
 * artifact. Decoding first and re-escaping after is what makes the pass
 * idempotent: text stays exactly as readable as the renderer meant it, and
 * anything that looks like markup stays inert on the way back out.
 */
const decodeEntities = (value: string): string =>
  value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body.startsWith("#x") || body.startsWith("#X")
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10_ff_ff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });

const escapeText = (value: string): string =>
  decodeEntities(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttribute = (value: string): string =>
  escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Attribute values that reference a document-local id, which must be
 *  rewritten in step with the ids themselves. */
const LOCAL_REF_ATTRIBUTES: ReadonlySet<string> = new Set(["fill", "stroke", "clip-path", "mask"]);

/**
 * Inline style properties a preview may keep.
 *
 * Sizing and spacing only — the geometry a component computes at render time
 * and cannot express as a class. Everything that could fetch (`background`,
 * `background-image`, `content`, `cursor`, `filter`, `mask`), break out of the
 * card (`position`, `z-index`, `transform`), or read as chrome the console did
 * not draw is simply not on the list.
 */
const ALLOWED_STYLE_PROPERTIES: ReadonlySet<string> = new Set([
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "flex",
  "flex-basis",
  "flex-grow",
  "flex-shrink",
  "gap",
  "aspect-ratio",
  "grid-template-columns",
  "grid-template-rows",
  "grid-column",
  "grid-row",
  "opacity",
  "text-align",
  "font-weight",
]);

/**
 * Keep the layout half of an inline style and drop everything else.
 *
 * Values are additionally required to be plain — digits, units, percentages,
 * keywords and simple functions like `calc()`/`minmax()`. Anything containing
 * a `url(`, an escape, or a scheme is dropped rather than parsed, because the
 * only reason a preview's inline style would contain one is a case this
 * function has not thought about.
 */
const sanitizeStyle = (value: string): string => {
  const kept: string[] = [];
  for (const declaration of value.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator === -1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const propertyValue = declaration.slice(separator + 1).trim();
    if (!ALLOWED_STYLE_PROPERTIES.has(property)) continue;
    if (propertyValue === "" || propertyValue.length > 64) continue;
    if (!/^[a-z0-9\s%.,()/_-]+$/i.test(propertyValue)) continue;
    if (/url\(|\\|expression|@import/i.test(propertyValue)) continue;
    kept.push(`${property}:${propertyValue}`);
  }
  return kept.join(";");
};

const rewriteLocalRef = (name: string, value: string): string => {
  if (!LOCAL_REF_ATTRIBUTES.has(name)) return value;
  // `url(#chart-gradient)` -> `url(#artifact-preview-chart-gradient)`. A `url()`
  // that is not a local fragment is a fetch, so it is dropped entirely.
  const match = /^url\(['"]?#([^'")]+)['"]?\)$/.exec(value.trim());
  if (match) return `url(#${PREVIEW_ID_PREFIX}${match[1] ?? ""})`;
  return /^url\(/i.test(value.trim()) ? "" : value;
};

/**
 * Parse one tag's attributes.
 *
 * A hand-rolled scan rather than a regex over the whole tag: attribute values
 * legitimately contain `>` (an SVG `d` path, a class list with an arbitrary
 * selector), and a regex that stops at the first `>` truncates those into
 * malformed output.
 */
const parseAttributes = (source: string): readonly (readonly [string, string])[] => {
  const attributes: (readonly [string, string])[] = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    const nameStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index] ?? "")) index += 1;
    const name = source.slice(nameStart, index).toLowerCase();
    if (name === "") {
      index += 1;
      continue;
    }
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== "=") {
      // A bare attribute (`hidden`). Valueless attributes carry no payload, so
      // the empty string is the faithful reading.
      attributes.push([name, ""]);
      continue;
    }
    index += 1;
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      const valueStart = index;
      while (index < source.length && source[index] !== quote) index += 1;
      attributes.push([name, source.slice(valueStart, index)]);
      index += 1;
    } else {
      const valueStart = index;
      while (index < source.length && !/[\s>]/.test(source[index] ?? "")) index += 1;
      attributes.push([name, source.slice(valueStart, index)]);
    }
  }
  return attributes;
};

const sanitizeAttributes = (tag: string, source: string): string => {
  const kept: string[] = [];
  for (const [name, rawValue] of parseAttributes(source)) {
    // Event handlers are the one class worth naming explicitly. React's server
    // renderer never emits them, so reaching this branch means the shape
    // changed underneath us — exactly the case the allowlist exists to survive.
    if (name.startsWith("on")) continue;
    if (name === "id") {
      if (rawValue !== "") kept.push(`id="${escapeAttribute(PREVIEW_ID_PREFIX + rawValue)}"`);
      continue;
    }
    if (!ALLOWED_ATTRIBUTES.has(name)) continue;
    // `value` is meaningful on a list item and is a form payload anywhere else.
    if (name === "value" && tag !== "li") continue;
    if (name === "style") {
      const style = sanitizeStyle(decodeEntities(rawValue));
      if (style !== "") kept.push(`style="${escapeAttribute(style)}"`);
      continue;
    }
    const value = rewriteLocalRef(name, rawValue);
    if (value === "") {
      if (LOCAL_REF_ATTRIBUTES.has(name)) continue;
      kept.push(name);
      continue;
    }
    // A URL-bearing value that survived the local-ref rewrite is still checked:
    // no scheme of any kind belongs in a preview attribute.
    if (/^\s*(?:javascript|data|vbscript|blob|file|https?):/i.test(value)) continue;
    kept.push(`${name}="${escapeAttribute(value)}"`);
  }
  return kept.length === 0 ? "" : ` ${kept.join(" ")}`;
};

/**
 * Whether a sanitized fragment is worth showing instead of the schematic.
 *
 * "Usable" means STRUCTURE survived, not text. The dominant preview is a
 * loading skeleton — empty divs whose classes are the entire picture, with no
 * text node anywhere — so a text requirement would reject the exact case this
 * feature exists for. What falls back instead is the degenerate render: a
 * single empty wrapper, or bare text with every element stripped, neither of
 * which reads as an interface.
 */
const isUsablePreview = (markup: string): boolean => {
  const elements = markup.match(/<[a-z][a-z0-9-]*/gi);
  if (!elements) return false;
  if (elements.length > 1) return true;
  // One element only: it has to carry something — text, or its own geometry.
  const text = markup.replace(/<[^>]*>/g, "").trim();
  return text !== "" || /<(?:svg|hr|table)\b/i.test(markup);
};

/**
 * Reduce smoke-render markup to inert, self-contained HTML.
 *
 * Allowlist-only, in one pass over the source:
 *
 *   - an element not in {@link ALLOWED_ELEMENTS} is unwrapped (its children
 *     survive) unless it carries code or fetches, in which case it and its
 *     content are cut;
 *   - an attribute not in {@link ALLOWED_ATTRIBUTES} is dropped, `on*` first;
 *   - comments and doctypes are dropped whole — `<!--[if]>` and friends are a
 *     parser-confusion surface with nothing to offer a preview;
 *   - ids are namespaced so the fragment cannot collide with the host document;
 *   - text is re-escaped, so anything the renderer left raw is neutralised.
 *
 * Returns `null` when there is nothing usable: empty input, markup that
 * sanitizes down to whitespace, or a result past
 * {@link ARTIFACT_PREVIEW_MARKUP_LIMIT}. Callers store `null` and fall back.
 */
export const sanitizeArtifactPreviewMarkup = (markup: string): string | null => {
  if (markup === "") return null;

  const output: string[] = [];
  // The nesting depth of a cut subtree. While non-zero, everything is dropped:
  // this is what makes `<script>`'s CONTENT go away and not just its tag.
  let skipDepth = 0;
  let skipTag = "";
  let index = 0;
  let size = 0;

  const push = (chunk: string): boolean => {
    size += chunk.length;
    if (size > ARTIFACT_PREVIEW_MARKUP_LIMIT) return false;
    output.push(chunk);
    return true;
  };

  while (index < markup.length) {
    const next = markup.indexOf("<", index);
    if (next === -1) {
      if (skipDepth === 0 && !push(escapeText(markup.slice(index)))) return null;
      break;
    }
    if (next > index && skipDepth === 0) {
      if (!push(escapeText(markup.slice(index, next)))) return null;
    }

    // Comments and doctypes: find the real terminator rather than the next `>`,
    // since a comment body may contain one.
    if (markup.startsWith("<!--", next)) {
      const end = markup.indexOf("-->", next + 4);
      index = end === -1 ? markup.length : end + 3;
      continue;
    }
    if (markup.startsWith("<!", next) || markup.startsWith("<?", next)) {
      const end = markup.indexOf(">", next);
      index = end === -1 ? markup.length : end + 1;
      continue;
    }

    // Walk to this tag's `>`, skipping any inside a quoted attribute value.
    let cursor = next + 1;
    let quote = "";
    while (cursor < markup.length) {
      const char = markup[cursor];
      if (quote !== "") {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
      cursor += 1;
    }
    if (cursor >= markup.length) break;

    const inner = markup.slice(next + 1, cursor);
    index = cursor + 1;

    const closing = inner.startsWith("/");
    const body = closing ? inner.slice(1) : inner;
    const selfClosing = body.endsWith("/");
    const normalized = selfClosing ? body.slice(0, -1) : body;
    const nameEnd = normalized.search(/[\s/]/);
    const tag = (nameEnd === -1 ? normalized : normalized.slice(0, nameEnd)).toLowerCase();
    if (tag === "") continue;

    if (skipDepth > 0) {
      // Inside a cut subtree: track only the tag that opened it, so a `<div>`
      // nested in a dropped `<script>` cannot close the skip early.
      if (tag === skipTag) skipDepth += closing ? -1 : 1;
      if (skipDepth === 0) skipTag = "";
      continue;
    }

    if (CONTENT_BEARING_REMOVALS.has(tag)) {
      if (!closing && !selfClosing) {
        skipDepth = 1;
        skipTag = tag;
      }
      continue;
    }

    // Unwrap: drop the tag, keep the children.
    if (!ALLOWED_ELEMENTS.has(tag)) continue;

    if (closing) {
      if (!VOID_ELEMENTS.has(tag) && !push(`</${tag}>`)) return null;
      continue;
    }

    const attributes = sanitizeAttributes(tag, normalized.slice(tag.length));
    if (VOID_ELEMENTS.has(tag)) {
      if (!push(`<${tag}${attributes} />`)) return null;
      continue;
    }
    if (!push(`<${tag}${attributes}>`)) return null;
    // A self-closing non-void tag in the source closes here too, so the output
    // stays balanced.
    if (selfClosing && !push(`</${tag}>`)) return null;
  }

  const result = output.join("");
  return isUsablePreview(result) ? result : null;
};
