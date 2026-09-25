/**
 * Plain-text source editing with Vim keys. `:w` and Mod-s save; the Vim status line shows the
 * mode and takes `:` commands.
 */
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder as hint } from "@codemirror/view";
import { Vim, vim } from "@replit/codemirror-vim";
import { useEffect, useLayoutEffect, useRef } from "react";

// Vim ex commands are global, so each view registers the save action for its own document.
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
  // CodeMirror draws the insert-mode cursor black by default, which vanishes in dark mode.
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--foreground)",
    borderLeftWidth: "2px",
  },
  "& .cm-fat-cursor": {
    background: "var(--foreground) !important",
    color: "var(--background) !important",
  },
  // Like a text field, show no cursor until the editor has focus.
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
  // The plugin sets an inline monospace font on the `:` prompt.
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
  /** Initial text. The editor owns the document after mount. */
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
          // Vim must come before other keymaps so it sees keys first.
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
