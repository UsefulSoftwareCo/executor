/** Authored Markdown parsed in process, with GFM as the connect form renders it. */
import { Effect } from "effect";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { MarkdownReader, MarkdownRefusals } from "../contracts/markdown.ts";

interface MarkdownNode {
  readonly type: string;
  readonly url?: string;
  readonly value?: string;
  readonly children?: ReadonlyArray<MarkdownNode>;
}

const nodes = (node: MarkdownNode): ReadonlyArray<MarkdownNode> => [
  node,
  ...(node.children ?? []).flatMap(nodes),
];

/**
 * An email address written as text, which GFM reads as a mailto link to itself. The form shows it
 * as the address, so help can name one.
 */
const writtenAddress = ({ url, children }: MarkdownNode) =>
  children?.length === 1 &&
  children[0]?.type === "text" &&
  url === `mailto:${children[0].value ?? ""}`;

/** What the connect form would not show in a piece of Markdown. */
const refusals = (text: string): MarkdownRefusals => {
  const found = nodes(
    fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
  );
  return {
    html: found.some((node) => node.type === "html"),
    image: found.some((node) => node.type === "image" || node.type === "imageReference"),
    // GFM reads a bare www.example.com as an http link, so it is refused like one. The form
    // links only an address written as https://, so `https:example.com` is refused too.
    links: found.flatMap((node) =>
      (node.type === "link" || node.type === "definition") &&
      node.url !== undefined &&
      !(/^https:\/\//i.test(node.url) && URL.canParse(node.url)) &&
      !(node.type === "link" && writtenAddress(node))
        ? [node.url]
        : [],
    ),
  };
};

/** What the connect form would not show in each piece of Markdown, parsed here; it never fails. */
export const markdownRefusals = ((texts) =>
  Effect.sync(() => texts.map(refusals))) satisfies MarkdownReader;
