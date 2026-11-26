import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AlertCircleIcon, Settings05Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { App } from "@executor-js/sdk";
import { Exit, type Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
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
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover.tsx";
import { Textarea } from "../components/textarea.tsx";
import { useHydrated } from "../hooks/hydrated.ts";
import {
  joinSkillDocument,
  skillDescription,
  splitSkillDocument,
  withSkillDescription,
} from "./skill-document.ts";

const serverRender = () => Promise.reject(new Error("The skill editor renders only in a browser"));
const VisualEditor = lazy(() =>
  (import.meta.env.SSR ? serverRender() : import("./markdown-editor.tsx")).then((module) => ({
    default: module.VisualEditor,
  })),
);
const VimEditor = lazy(() =>
  (import.meta.env.SSR ? serverRender() : import("./vim-editor.tsx")).then((module) => ({
    default: module.VimEditor,
  })),
);

const vimKey = "executor:skill-editor:vim";

function useVimMode(hydrated: boolean) {
  const [chosen, setChosen] = useState<boolean>();
  const enabled = chosen ?? (hydrated && localStorage.getItem(vimKey) === "on");
  const set = (next: boolean) => {
    localStorage.setItem(vimKey, next ? "on" : "off");
    setChosen(next);
  };
  return [enabled, set] as const;
}

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

export interface Committed {
  readonly commit: string;
  readonly deploy: boolean;
}

export interface SkillEditing<E> {
  readonly atoms: AppManagementAtoms<E>;
  readonly onApp: AppAcknowledgement;
  readonly onDirty: (dirty: boolean) => void;
}

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
  readonly path: string;
  readonly skill: string;
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
  const hydrated = useHydrated();
  const [vimMode, setVimMode] = useVimMode(hydrated);
  const [chosenMode, setMode] = useState<"visual" | "markdown">();
  const mode = chosenMode ?? (markdown && !vimMode ? "visual" : "markdown");
  const [session, setSession] = useState({ id: 0, original: parts.body });
  const commit = useAtomSet(editing.atoms.commitFile(app.id), { mode: "promiseExit" });
  const version = useAtomValue(editing.atoms.deploy(app.id));
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
    if (!dirty || (instructions && !description.trim()) || savingRef.current || version.waiting)
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
                  setMode(vimMode ? mode : "markdown");
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
                if (window.confirm("Discard your changes to this file?")) load(stored);
              }}
            >
              Discard
            </Button>
          )}
          <Button
            size="sm"
            loading={saving || version.waiting}
            disabled={!dirty || saving || version.waiting || (instructions && !description.trim())}
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
            readOnly={!hydrated}
            maxLength={1024}
            required
            placeholder="Describe when agents should use this skill"
            className="field-sizing-content min-h-0 resize-none rounded-none border-0 bg-transparent p-0 text-sm leading-6 text-muted-foreground shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </label>
      )}
      {!hydrated ? (
        reader
      ) : mode === "visual" ? (
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

export function SkillDeploy<E>({
  app,
  commit,
  deployNow,
  onStarted,
  editing,
}: {
  readonly app: App;
  readonly commit: string;
  readonly deployNow: boolean;
  readonly onStarted: () => void;
  readonly editing: SkillEditing<E>;
}) {
  const deploy = useAtomSet(editing.atoms.deploy(app.id), { mode: "promise" });
  const started = useRef(false);
  useLayoutEffect(() => {
    if (!deployNow || started.current) return;
    started.current = true;
    onStarted();
    void deploy({ commit, onApp: editing.onApp }).catch(() => {});
  });
  return null;
}

export function SkillDeployStatus<E>({
  app,
  commit,
  deployNow,
  editing,
  Failure,
}: {
  readonly app: App;
  readonly commit: string;
  readonly deployNow: boolean;
  readonly editing: SkillEditing<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const state = useAtomValue(editing.atoms.deploy(app.id));
  const deploy = useAtomSet(editing.atoms.deploy(app.id), { mode: "promise" });
  const failure = !state.waiting && AsyncResult.isFailure(state) ? state.cause : undefined;
  const [seen, setSeen] = useState(failure);
  const [open, setOpen] = useState(false);
  if (failure !== seen) {
    setSeen(failure);
    if (failure !== undefined) setOpen(true);
  }
  const deployed = AsyncResult.isSuccess(state) && state.value.version.sourceCommit === commit;
  const deploying = state.waiting || deployNow;
  return (
    <span role="status" className="inline-flex items-center">
      {deployed ? (
        <span className="sr-only">Saved and deployed.</span>
      ) : deploying ? (
        <span className="sr-only">Saved. Deploying…</span>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
              <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} aria-hidden />
              Not deployed
            </Button>
          </PopoverTrigger>
          <PopoverContent
            aria-label="Deploy failed"
            className="flex w-80 flex-col items-start gap-3 text-xs"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <p>Saved, but not deployed. Retry to make your changes live.</p>
            {failure !== undefined && <Failure cause={failure} layout="compact" />}
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setOpen(false);
                void deploy({ commit, onApp: editing.onApp }).catch(() => {});
              }}
            >
              Retry deploy
            </Button>
          </PopoverContent>
        </Popover>
      )}
    </span>
  );
}
