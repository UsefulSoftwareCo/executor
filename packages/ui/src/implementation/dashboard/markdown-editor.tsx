/**
 * Always-on visual Markdown editing that looks like the rendered page. Formatting comes from
 * Markdown shortcuts, a menu on selected text and a `/` block menu. Output keeps untouched blocks
 * byte-for-byte.
 */
import {
  Editor,
  defaultValueCtx,
  editorViewOptionsCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
} from "@milkdown/kit/core";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import {
  commonmark,
  createCodeBlockCommand,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { gfm, insertTableCommand, toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose, $remark, callCommand, getMarkdown, type $Command } from "@milkdown/kit/utils";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import {
  CodeSquareIcon,
  Heading01Icon,
  Heading02Icon,
  Heading03Icon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  Link01Icon,
  MinusSignIcon,
  QuoteDownIcon,
  SourceCodeIcon,
  Table01Icon,
  TextBoldIcon,
  TextIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { cn } from "../lib/utils.ts";
import { preserveMarkdown } from "./markdown-preserve.ts";
import { markdownProse } from "./markdown-prose.ts";

/** Editing-only additions: inline code chips, quotes, rules and GFM task items. */
const editorProse =
  "[&_.ProseMirror]:min-h-40 [&_.ProseMirror]:outline-none [&_.ProseMirror]:before:content-[attr(data-placeholder)] [&_.ProseMirror]:before:float-left [&_.ProseMirror]:before:h-0 [&_.ProseMirror]:before:pointer-events-none [&_.ProseMirror]:before:text-muted-foreground [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_hr]:my-6 [&_a]:underline [&_li>p]:my-1 [&_td>p]:my-0 [&_th>p]:my-0 [&_li[data-item-type=task]]:list-none [&_li[data-item-type=task]]:before:mr-2 [&_li[data-item-type=task]]:before:content-['☐'] [&_li[data-item-type=task][data-checked=true]]:before:content-['☑'] [&_li[data-item-type=task]>p]:inline [&_.selectedCell]:bg-accent";

/** The GFM preset gives title-less images a null title, which the schema rejects and drops. */
const imageTitle = $remark("imageTitle", () => () => (tree) => {
  const visit = (node: { type: string; title?: unknown; children?: unknown[] }) => {
    if (node.type === "image" && node.title == null) node.title = "";
    for (const child of node.children ?? []) visit(child as typeof node);
  };
  visit(tree as Parameters<typeof visit>[0]);
});

interface Block {
  readonly label: string;
  readonly icon: IconSvgElement;
  readonly run: (editor: Editor) => void;
}
const command =
  <T,>(slice: $Command<T>, payload?: T) =>
  (editor: Editor) =>
    editor.action(callCommand(slice.key, payload));
const blocks: readonly Block[] = [
  { label: "Text", icon: TextIcon, run: command(turnIntoTextCommand) },
  { label: "Heading 1", icon: Heading01Icon, run: command(wrapInHeadingCommand, 1) },
  { label: "Heading 2", icon: Heading02Icon, run: command(wrapInHeadingCommand, 2) },
  { label: "Heading 3", icon: Heading03Icon, run: command(wrapInHeadingCommand, 3) },
  {
    label: "Bulleted list",
    icon: LeftToRightListBulletIcon,
    run: command(wrapInBulletListCommand),
  },
  {
    label: "Numbered list",
    icon: LeftToRightListNumberIcon,
    run: command(wrapInOrderedListCommand),
  },
  { label: "Quote", icon: QuoteDownIcon, run: command(wrapInBlockquoteCommand) },
  { label: "Code block", icon: CodeSquareIcon, run: command(createCodeBlockCommand) },
  { label: "Table", icon: Table01Icon, run: command(insertTableCommand) },
  { label: "Divider", icon: MinusSignIcon, run: command(insertHrCommand) },
];

interface Point {
  readonly top: number;
  readonly left: number;
}
interface Slash extends Point {
  readonly from: number;
  readonly to: number;
  readonly query: string;
}

/**
 * Uncontrolled: `original` loads once. Remount with a new `key` to load another document.
 * `onChange` receives the complete Markdown text after every edit.
 */
export function VisualEditor(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly original: string;
  readonly onChange: (markdown: string) => void;
  readonly onSave: () => void;
}) {
  return (
    <MilkdownProvider>
      <Surface {...props} />
    </MilkdownProvider>
  );
}

function Surface({
  label,
  placeholder,
  original,
  onChange,
  onSave,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly original: string;
  readonly onChange: (markdown: string) => void;
  readonly onSave: () => void;
}) {
  const [loading, editor] = useInstance();
  const [bubble, setBubble] = useState<Point | null>(null);
  // The link field takes focus from the editor, so it outlives the selection menu's blur.
  const [link, setLink] = useState<{ href: string; at: Point } | null>(null);
  const [slash, setSlash] = useState<Slash | null>(null);
  const [active, setActive] = useState(0);
  const view = useRef<EditorView | null>(null);
  // A dismissed `/` stays closed until the person types a different one.
  const dismissed = useRef<number | null>(null);
  const options = slash
    ? blocks.filter((block) => block.label.toLowerCase().includes(slash.query.toLowerCase()))
    : [];
  const choose = (block: Block) => {
    const current = view.current;
    if (loading || current === null || slash === null) return;
    current.dispatch(current.state.tr.delete(slash.from, slash.to));
    setSlash(null);
    block.run(editor());
    current.focus();
  };
  const highlighted = Math.min(active, Math.max(options.length - 1, 0));
  // ProseMirror's key handler outlives renders; it reads the latest menu state from here.
  const live = useRef({ slash, active: highlighted, onSave, choose });
  useLayoutEffect(() => {
    live.current = { slash, active: highlighted, onSave, choose };
  });

  const sync = (next: EditorView) => {
    view.current = next;
    const { selection } = next.state;
    const code = selection.$from.parent.type.spec.code === true;
    if (!selection.empty && !code && next.hasFocus()) {
      const start = next.coordsAtPos(selection.from);
      const end = next.coordsAtPos(selection.to);
      setBubble({ top: Math.min(start.top, end.top), left: (start.left + end.right) / 2 });
    } else setBubble(null);
    const before =
      selection.empty && !code
        ? selection.$from.parent.textBetween(0, selection.$from.parentOffset, undefined, "￼")
        : "";
    const match = /(?:^|\s)\/([\w-]*)$/.exec(before);
    if (match === null || !next.hasFocus()) {
      setSlash(null);
      return;
    }
    const from = selection.from - match[1]!.length - 1;
    if (dismissed.current === from) return setSlash(null);
    dismissed.current = null;
    const at = next.coordsAtPos(from);
    setSlash((previous) => {
      if (previous?.from !== from) setActive(0);
      return { from, to: selection.from, query: match[1]!, top: at.bottom, left: at.left };
    });
  };

  useEditor((root) => {
    // The editor's own serialization of `original`, before any edit.
    let baseline: string | undefined;
    const menus = $prose(
      () =>
        new Plugin({
          view: (initial) => {
            sync(initial);
            return { update: sync };
          },
          props: {
            handleKeyDown: (_, event) => {
              const state = live.current;
              if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                event.preventDefault();
                state.onSave();
                return true;
              }
              if (state.slash === null) return false;
              const matches = blocks.filter((block) =>
                block.label.toLowerCase().includes(state.slash!.query.toLowerCase()),
              );
              if (matches.length === 0) return false;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((state.active + step + matches.length) % matches.length);
                return true;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                state.choose(matches[state.active]!);
                return true;
              }
              if (event.key === "Escape") {
                dismissed.current = state.slash.from;
                setSlash(null);
                return true;
              }
              return false;
            },
          },
        }),
    );
    return Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, original);
        ctx.update(remarkStringifyOptionsCtx, (options) => ({
          ...options,
          bullet: "-" as const,
          rule: "-" as const,
          fences: true,
        }));
        ctx.update(editorViewOptionsCtx, (options) => ({
          ...options,
          attributes: (state) => ({
            "data-placeholder":
              state.doc.childCount === 1 &&
              state.doc.firstChild?.type.name === "paragraph" &&
              state.doc.firstChild.content.size === 0
                ? placeholder
                : "",
            role: "textbox",
            "aria-multiline": "true",
            "aria-label": label,
            spellcheck: "true",
          }),
        }));
        ctx
          .get(listenerCtx)
          .mounted((ctx) => {
            baseline = getMarkdown()(ctx);
          })
          .markdownUpdated((_, markdown) => {
            onChange(
              baseline === undefined ? markdown : preserveMarkdown(original, baseline, markdown),
            );
          })
          .blur(() => setBubble(null));
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(clipboard)
      .use(listener)
      .use(imageTitle)
      .use(menus);
  }, []);

  // Menus are fixed to the viewport, so scrolling must move them with the text.
  useEffect(() => {
    const follow = () => {
      if (view.current !== null) sync(view.current);
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, []);

  return (
    <div className={cn(markdownProse, editorProse)}>
      <Milkdown />
      {(bubble !== null || link !== null) && !loading && (
        <SelectionMenu
          at={link?.at ?? bubble!}
          link={link}
          onLink={setLink}
          run={(block) => block.run(editor())}
          view={view}
        />
      )}
      {slash !== null && options.length > 0 && (
        <div
          role="listbox"
          aria-label="Insert block"
          style={{ top: slash.top + 6, left: slash.left }}
          className="fixed z-50 w-56 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md"
        >
          {options.map((block, index) => (
            <button
              key={block.label}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(block)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left aria-selected:bg-accent"
            >
              <HugeiconsIcon icon={block.icon} size={16} aria-hidden />
              {block.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const marks: readonly Block[] = [
  { label: "Bold", icon: TextBoldIcon, run: command(toggleStrongCommand) },
  { label: "Italic", icon: TextItalicIcon, run: command(toggleEmphasisCommand) },
  { label: "Strikethrough", icon: TextStrikethroughIcon, run: command(toggleStrikethroughCommand) },
  { label: "Code", icon: SourceCodeIcon, run: command(toggleInlineCodeCommand) },
];

/** Formatting for selected text, placed above the selection like a document editor. */
function SelectionMenu({
  at,
  link,
  onLink: setLink,
  run,
  view,
}: {
  readonly at: Point;
  readonly link: { readonly href: string; readonly at: Point } | null;
  readonly onLink: (link: { href: string; at: Point } | null) => void;
  readonly run: (block: Block) => void;
  readonly view: { readonly current: EditorView | null };
}) {
  return (
    <div
      role="toolbar"
      aria-label="Format text"
      style={{ top: at.top - 8, left: at.left }}
      className="fixed z-50 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {link === null ? (
        <>
          {marks.map((mark) => (
            <Button
              key={mark.label}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={mark.label}
              title={mark.label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run(mark)}
            >
              <HugeiconsIcon icon={mark.icon} size={16} aria-hidden />
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Link"
            title="Link"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setLink({ href: "", at })}
          >
            <HugeiconsIcon icon={Link01Icon} size={16} aria-hidden />
          </Button>
        </>
      ) : (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const href = link.href.trim();
            setLink(null);
            view.current?.focus();
            if (href)
              run({ label: "Link", icon: Link01Icon, run: command(toggleLinkCommand, { href }) });
          }}
        >
          <Input
            autoFocus
            aria-label="Link URL"
            placeholder="https:// or references/file.md"
            value={link.href}
            onChange={(event) => setLink({ ...link, href: event.target.value })}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setLink(null);
              view.current?.focus();
            }}
            className="h-8 w-64 text-xs"
          />
          <Button size="sm">Add</Button>
        </form>
      )}
    </div>
  );
}
