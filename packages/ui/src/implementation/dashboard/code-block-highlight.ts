import type { Node } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import type { HighlighterCore } from "shiki/core";
import { fenceLanguage } from "../../contracts/code-language.ts";
import { highlightTokens } from "../../contracts/highlight.ts";

const key = new PluginKey<DecorationSet>("codeBlockHighlight");

export function codeBlockHighlight(highlighter: () => HighlighterCore | undefined) {
  const decorate = (doc: Node) => {
    const current = highlighter();
    if (current === undefined) return DecorationSet.empty;
    const decorations: Decoration[] = [];
    doc.descendants((node, position) => {
      if (node.type.name !== "code_block") return true;
      const language = fenceLanguage(String(node.attrs.language));
      let from = position + 1;
      for (const line of highlightTokens(current, node.textContent, language)) {
        for (const token of line) {
          const to = from + token.content.length;
          if (token.htmlStyle !== undefined && to > from)
            decorations.push(
              Decoration.inline(from, to, {
                style: Object.entries(token.htmlStyle)
                  .map(([property, value]) => `${property}:${value}`)
                  .join(";"),
              }),
            );
          from = to;
        }
        from += 1;
      }
      return false;
    });
    return DecorationSet.create(doc, decorations);
  };
  return new Plugin({
    key,
    state: {
      init: (_, state) => decorate(state.doc),
      apply: (transaction, previous) =>
        transaction.docChanged || transaction.getMeta(key) === true
          ? decorate(transaction.doc)
          : previous,
    },
    props: { decorations: (state) => key.getState(state) },
  });
}

export function refreshCodeBlockHighlight(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(key, true));
}
