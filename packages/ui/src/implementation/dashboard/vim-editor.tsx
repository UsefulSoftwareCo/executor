import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder as hint } from "@codemirror/view";
import { Vim, vim } from "@replit/codemirror-vim";
import { useEffect, useLayoutEffect, useRef } from "react";

const saves = new WeakMap<EditorView, () => void>();
Vim.defineEx("write", "w", (cm) => saves.get(cm.cm6)?.());

const theme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "inherit" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit" },
  ".cm-content": { minHeight: "10rem", padding: "0" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  "& .cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    background: "color-mix(in oklab, var(--foreground) 18%, transparent) !important",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--foreground)",
    borderLeftWidth: "2px",
  },
  "& .cm-fat-cursor": {
    background: "var(--foreground) !important",
    color: "var(--background) !important",
  },
  "&:not(.cm-focused) .cm-fat-cursor": { display: "none" },
  ".cm-panels": { backgroundColor: "transparent", color: "inherit" },
  ".cm-panels-bottom": {
    borderTop: "1px solid var(--border)",
    marginTop: "0.75rem",
  },
  ".cm-vim-panel": {
    padding: "0.25rem 0",
    fontFamily: "inherit",
    color: "var(--muted-foreground)",
  },
  ".cm-vim-panel *": { fontFamily: "inherit !important" },
  ".cm-vim-panel input": { color: "var(--foreground)" },
});

export function VimEditor({
  label,
  placeholder,
  value,
  onChange,
  onSave,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSave: () => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const latest = useRef({ onChange, onSave });
  useLayoutEffect(() => {
    latest.current = { onChange, onSave };
  });
  const initial = useRef(value);
  useEffect(() => {
    const save = () => latest.current.onSave();
    const view = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          vim({ status: true }),
          Prec.highest(
            keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (save(), true) }]),
          ),
          history(),
          drawSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          hint(placeholder),
          EditorView.contentAttributes.of({
            "aria-label": label,
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
          theme,
        ],
      }),
    });
    saves.set(view, save);
    return () => view.destroy();
  }, [label, placeholder]);
  return <div ref={parent} className="font-mono text-xs leading-6" />;
}
