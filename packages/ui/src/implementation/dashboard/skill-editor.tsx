/** Edit a skill file in place from working source and save it as a Git commit. */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Settings05Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { App } from "@executor-js/sdk";
import { Exit, type Cause } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { AppAcknowledgement, AppManagementAtoms } from "../../contracts/app-management.ts";
import type { FailureProps } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu.tsx";
import { Textarea } from "../components/textarea.tsx";
import {
  joinSkillDocument,
  skillDescription,
  splitSkillDocument,
  withSkillDescription,
} from "./skill-document.ts";

// Readers never download the editor; it loads when an editable file opens.
const VisualEditor = lazy(() =>
  import("./markdown-editor.tsx").then((module) => ({ default: module.VisualEditor })),
);
const VimEditor = lazy(() =>
  import("./vim-editor.tsx").then((module) => ({ default: module.VimEditor })),
);

const vimKey = "executor:skill-editor:vim";

/** A per-browser preference: people who use Vim keys want them in every file. */
function useVimMode() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(vimKey) === "on");
  const set = (next: boolean) => {
    localStorage.setItem(vimKey, next ? "on" : "off");
    setEnabled(next);
  };
  return [enabled, set] as const;
}

/** A settings menu row with a switch; the menu stays open so several settings can change. */
function SwitchItem({
  checked,
  onToggle,
  children,
}: {
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <DropdownMenuItem
      role="menuitemcheckbox"
      aria-checked={checked}
      onSelect={(event) => {
        event.preventDefault();
        onToggle();
      }}
    >
      {children}
      <span
        aria-hidden
        data-on={checked || undefined}
        className="group ml-auto flex h-4 w-7 items-center rounded-full bg-input p-0.5 transition-colors data-on:bg-primary"
      >
        <span className="size-3 rounded-full bg-background shadow-sm transition-transform group-data-on:translate-x-3" />
      </span>
    </DropdownMenuItem>
  );
}

/** A commit made by the editor, and whether the person asked to deploy it. */
export interface Committed {
  readonly commit: string;
  readonly deploy: boolean;
}

/** Hosts that can write app source pass their management atoms; others render skills read-only. */
export interface SkillEditing<E> {
  readonly atoms: AppManagementAtoms<E>;
  readonly onApp: AppAcknowledgement;
  /** Report draft state to the host navigation guard. */
  readonly onDirty: (dirty: boolean) => void;
}

/**
 * The file is the editor: it renders like the reader and is always editable. The header shows
 * the save controls. `reader` stands in while the editor code loads, so the page never jumps.
 */
export function SkillFileEditor<E>({
  app,
  path,
  skill,
  stored,
  editing,
  Failure,
  header,
  reader,
  onDirty,
  onCommitted,
}: {
  readonly app: App;
  /** Path in app source, for example `skills/<name>/SKILL.md`. */
  readonly path: string;
  readonly skill: string;
  /** Exact working-source content. A later read never replaces an open draft's base. */
  readonly stored: string;
  readonly editing: SkillEditing<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly header: (actions: ReactNode) => ReactNode;
  readonly reader: ReactNode;
  readonly onDirty: (dirty: boolean) => void;
  readonly onCommitted: (result: Committed) => void;
}) {
  const instructions = path.endsWith("/SKILL.md");
  const [base, setBase] = useState(stored);
  const [parts, setParts] = useState(() => splitSkillDocument(stored));
  const [description, setDescription] = useState(() => skillDescription(parts.frontmatter));
  const [body, setBody] = useState(parts.body);
  const markdown = /\.md$/i.test(path);
  const [vimMode, setVimMode] = useVimMode();
  // Vim keys edit the Markdown source, so Vim users open files there.
  const [mode, setMode] = useState<"visual" | "markdown">(
    markdown && !vimMode ? "visual" : "markdown",
  );
  // Each visual session keeps bytes relative to the text it loaded.
  const [session, setSession] = useState({ id: 0, original: parts.body });
  const commit = useAtomSet(editing.atoms.commitFile(app.id), { mode: "promiseExit" });
  const deployment = useAtomValue(editing.atoms.deploy(app.id));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const [changed, setChanged] = useState(false);
  const content = joinSkillDocument({
    frontmatter: instructions
      ? withSkillDescription(parts.frontmatter, description)
      : parts.frontmatter,
    body,
  });
  const dirty = content !== base;
  const onEditingDirty = editing.onDirty;
  useEffect(() => {
    onDirty(dirty);
    onEditingDirty(dirty);
  }, [dirty, onDirty, onEditingDirty]);
  useEffect(
    () => () => {
      onDirty(false);
      onEditingDirty(false);
    },
    [onDirty, onEditingDirty],
  );
  const load = (next: string) => {
    const split = splitSkillDocument(next);
    setBase(next);
    setParts(split);
    setDescription(skillDescription(split.frontmatter));
    setBody(split.body);
    setSession({ id: session.id + 1, original: split.body });
  };
  const save = async () => {
    if (!dirty || (instructions && !description.trim()) || savingRef.current || deployment.waiting)
      return;
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    setChanged(false);
    const result = await commit({
      path,
      base,
      content,
      message: `Update ${instructions ? `${skill} skill` : `${skill}/${name}`}`,
    });
    savingRef.current = false;
    setSaving(false);
    if (Exit.isFailure(result)) setError(result.cause);
    else if (result.value._tag === "FileChanged") setChanged(true);
    else {
      // Keep any text typed while saving; only the saved snapshot becomes the new base.
      setBase(content);
      onCommitted({ commit: result.value.commit, deploy: true });
    }
  };
  const name = path.split("/").at(-1) ?? path;
  const label = instructions ? "Skill instructions" : `Edit ${name}`;
  const placeholder = instructions ? "Write skill instructions here…" : "Write file contents here…";
  return (
    <div className="flex min-w-0 flex-col">
      {header(
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Editor settings"
                className="text-muted-foreground"
              >
                <HugeiconsIcon icon={Settings05Icon} strokeWidth={2} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {markdown && (
                <SwitchItem
                  checked={mode === "markdown"}
                  onToggle={() => {
                    if (mode === "markdown") setSession({ id: session.id + 1, original: body });
                    setMode(mode === "visual" ? "markdown" : "visual");
                  }}
                >
                  Markdown
                </SwitchItem>
              )}
              <SwitchItem
                checked={vimMode}
                onToggle={() => {
                  setVimMode(!vimMode);
                  if (!vimMode) setMode("markdown");
                }}
              >
                Vim mode
              </SwitchItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                // `stored` is the latest read, which may be newer than this draft's base.
                if (window.confirm("Discard your changes to this file?")) load(stored);
              }}
            >
              Discard
            </Button>
          )}
          <Button
            size="sm"
            loading={saving}
            disabled={
              !dirty || saving || deployment.waiting || (instructions && !description.trim())
            }
            onClick={save}
          >
            Save
          </Button>
        </>,
      )}
      {instructions && (
        <label className="mb-4 block">
          <span className="sr-only">Description</span>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                event.preventDefault();
                save();
              }
            }}
            rows={1}
            maxLength={1024}
            required
            placeholder="Describe when agents should use this skill"
            className="field-sizing-content min-h-0 resize-none rounded-none border-0 bg-transparent p-0 text-sm leading-6 text-muted-foreground shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </label>
      )}
      {mode === "visual" ? (
        <Suspense fallback={reader}>
          <VisualEditor
            key={session.id}
            label={label}
            placeholder={placeholder}
            original={session.original}
            onChange={setBody}
            onSave={save}
          />
        </Suspense>
      ) : vimMode ? (
        <Suspense fallback={null}>
          <VimEditor
            key={session.id}
            label={label}
            placeholder={placeholder}
            value={body}
            onChange={setBody}
            onSave={save}
          />
        </Suspense>
      ) : (
        <Textarea
          aria-label={label}
          placeholder={placeholder}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              save();
            }
          }}
          spellCheck={false}
          className="field-sizing-content min-h-40 resize-none rounded-none border-0 bg-transparent p-0 font-mono text-xs leading-6 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      )}
      {changed && (
        <p role="alert" className="mt-4 rounded-md border border-destructive/40 p-3 text-sm">
          Someone else changed this file after you started editing. Copy your changes, then discard
          them to load the latest version.
        </p>
      )}
      {error && <Failure cause={error} />}
    </div>
  );
}

/** Deploy a commit made by the editor; the committed source is safe even if this fails. */
export function SkillDeployment<E>({
  app,
  commit,
  deployNow,
  onStarted,
  editing,
  Failure,
}: {
  readonly app: App;
  readonly commit: string;
  /** Start deploying on mount, independently of the selected editor. */
  readonly deployNow: boolean;
  /** The owner clears its request so a remount never deploys twice. */
  readonly onStarted: () => void;
  readonly editing: SkillEditing<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const state = useAtomValue(editing.atoms.deploy(app.id));
  const deploy = useAtomSet(editing.atoms.deploy(app.id), { mode: "promise" });
  const run = () => void deploy({ commit, onApp: editing.onApp }).catch(() => {});
  const started = useRef(false);
  useEffect(() => {
    if (!deployNow || started.current) return;
    started.current = true;
    onStarted();
    run();
  });
  // The deploy atom is shared with the Source view; only a deployment of this commit counts.
  const deployed = AsyncResult.isSuccess(state) && state.value.deployment.sourceCommit === commit;
  if (deployed) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 border-b px-5 py-3 text-xs">
      <span className="text-muted-foreground">
        {state.waiting || deployNow
          ? "Saved. Deploying…"
          : "Saved, but not deployed. Retry to make your changes live."}
      </span>
      {!state.waiting && !deployed && (
        <Button size="xs" variant="outline" onClick={run}>
          Retry deploy
        </Button>
      )}
      {!state.waiting && AsyncResult.isFailure(state) && <Failure cause={state.cause} />}
    </div>
  );
}
