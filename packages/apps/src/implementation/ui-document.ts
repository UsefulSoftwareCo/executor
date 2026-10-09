/** Point a retained document's resources at its deployment while links keep the page's own URL. */
import {
  isTokenAtKeyword,
  isTokenFunction,
  isTokenString,
  isTokenURL,
  isTokenWhiteSpaceOrComment,
  tokenize,
} from "@csstools/css-tokenizer";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

type Element = DefaultTreeAdapterMap["element"];
const elements = (node: DefaultTreeAdapterMap["node"]): Element[] => [
  ...("tagName" in node ? [node] : []),
  ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
  ...(node.nodeName === "template" && "content" in node ? elements(node.content) : []),
];

/**
 * Attributes the browser fetches as subresources, including SVG `href` and `xlink:href`, which the
 * parser stores as `href`. Navigation targets (`a`, `form`, `iframe`) are absent.
 */
const resources: Readonly<Record<string, readonly string[]>> = {
  script: ["src"],
  link: ["href", "imagesrcset"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  input: ["src"],
  embed: ["src"],
  object: ["data"],
  use: ["href"],
  image: ["href"],
  feImage: ["href"],
};
const candidateLists = new Set(["srcset", "imagesrcset"]);

/** Link relations that fetch the target. Others, such as `canonical` or `next`, name a page. */
const resourceLinks = new Set([
  "stylesheet",
  "icon",
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
  "mask-icon",
  "manifest",
  "preload",
  "modulepreload",
  "prefetch",
]);

/** Only path-relative references name a retained file; absolute paths, schemes and fragments do not. */
const retained = (url: string) => url !== "" && !/^(?:[a-z][a-z\d+.-]*:|[/#?])/i.test(url);

/**
 * Rewrite each candidate URL as the HTML `srcset` parser splits them: a URL is a run of
 * non-whitespace whose trailing commas end the candidate, and descriptors end at a comma outside
 * parentheses. Commas inside a URL, as in `data:` URLs, are part of it.
 */
const rewriteSrcset = (value: string, resolve: (url: string) => string) => {
  let output = "";
  let index = 0;
  while (index < value.length) {
    const separator = /^[\s,]*/.exec(value.slice(index))?.[0] ?? "";
    output += separator;
    index += separator.length;
    const token = /^\S+/.exec(value.slice(index))?.[0];
    if (token === undefined) break;
    index += token.length;
    const commas = /,*$/.exec(token)?.[0] ?? "";
    output += resolve(token.slice(0, token.length - commas.length)) + commas;
    if (commas !== "") continue;
    let depth = 0;
    let end = index;
    for (; end < value.length; end++) {
      const character = value[end];
      if (character === "(") depth++;
      else if (character === ")") depth = Math.max(0, depth - 1);
      else if (character === "," && depth === 0) break;
    }
    output += value.slice(index, end);
    index = end;
  }
  return output;
};

const quoteCss = (value: string) =>
  `"${value.replace(/["\\\n]/g, (character) => (character === "\n" ? "\\a " : `\\${character}`))}"`;

/**
 * Inline CSS has no stylesheet URL of its own, so its `url()` and `@import` targets follow the page.
 * A CSS Syntax tokenizer decodes escapes and separates strings and comments; unchanged tokens keep
 * their original text, and only resolved URLs are re-serialized.
 */
const rewriteCss = (css: string, resolve: (url: string) => string) => {
  const tokens = tokenize({ css });
  const rewrite = (raw: string, value: string, format: (url: string) => string) => {
    const resolved = resolve(value);
    return resolved === value ? raw : format(resolved);
  };
  let output = "";
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (isTokenURL(token)) {
      output += rewrite(token[1], token[4].value, (url) => `url(${quoteCss(url)})`);
      continue;
    }
    output += token[1];
    const target =
      (isTokenFunction(token) && token[4].value.toLowerCase() === "url") ||
      (isTokenAtKeyword(token) && token[4].value.toLowerCase() === "import");
    if (!target) continue;
    let next = index + 1;
    while (next < tokens.length && isTokenWhiteSpaceOrComment(tokens[next]!))
      output += tokens[next++]![1];
    const string = tokens[next];
    if (string !== undefined && isTokenString(string)) {
      output += rewrite(string[1], string[4].value, quoteCss);
      index = next;
    } else index = next - 1;
  }
  return output;
};

/**
 * Retained files sit at the deployment's asset root. Resolving path-relative resource URLs there,
 * instead of with `<base>`, leaves the document base as the page URL for links, history and forms.
 */
export const deploymentDocument = (html: string, deployment: string) => {
  const root = `/_executor/assets/${encodeURIComponent(deployment)}/`;
  const resolve = (url: string) => {
    if (!retained(url) || !URL.canParse(url, "https://deployment.invalid/")) return url;
    const resolved = new URL(url, "https://deployment.invalid/");
    return `${root}${resolved.pathname.slice(1)}${resolved.search}${resolved.hash}`;
  };
  const document = parse(html);
  for (const element of elements(document)) {
    if (element.tagName === "style")
      for (const node of element.childNodes)
        if (node.nodeName === "#text" && "value" in node)
          node.value = rewriteCss(node.value, resolve);
    const names =
      element.tagName === "link" &&
      !(element.attrs.find((attribute) => attribute.name === "rel")?.value ?? "")
        .toLowerCase()
        .split(/\s+/)
        .some((relation) => resourceLinks.has(relation))
        ? []
        : (resources[element.tagName] ?? []);
    for (const attribute of element.attrs) {
      if (attribute.name === "style") attribute.value = rewriteCss(attribute.value, resolve);
      else if (candidateLists.has(attribute.name) && names.includes(attribute.name))
        attribute.value = rewriteSrcset(attribute.value, resolve);
      else if (names.includes(attribute.name)) attribute.value = resolve(attribute.value.trim());
    }
  }
  return serialize(document);
};
