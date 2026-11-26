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

const writtenAddress = ({ url, children }: MarkdownNode) =>
  children?.length === 1 &&
  children[0]?.type === "text" &&
  url === `mailto:${children[0].value ?? ""}`;

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

export const markdownRefusals = ((texts) =>
  Effect.sync(() => texts.map(refusals))) satisfies MarkdownReader;
