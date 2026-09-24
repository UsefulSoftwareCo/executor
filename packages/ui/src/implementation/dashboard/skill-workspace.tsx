import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { useAtomSet } from "@effect/atom-react";
import type { App, AppSkillBundle } from "@executor-js/sdk";
import type { AppSourceView } from "@executor-js/app-management/contracts";
import { Exit, type Cause } from "effect";
import { stringify } from "yaml";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  File01Icon,
  Folder01Icon,
  LockKeyIcon,
} from "@hugeicons/core-free-icons";
import type { FailureProps } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { Textarea } from "../components/textarea.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/dialog.tsx";
import { SkillFileEditor, type SkillEditing, type Committed } from "./skill-editor.tsx";
import { SkillContent } from "./skill-content.tsx";
import { skillDescription, splitSkillDocument } from "./skill-document.ts";

interface Skill {
  readonly name: string;
  readonly description: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly editable: boolean;
}
type Creating = { readonly kind: "skill" } | { readonly kind: "file"; readonly skill: string };
type Selection = { readonly skill: string; readonly file: string };

/** Working source is editable before deployment; app-provided skills remain available read-only. */
export function SkillWorkspace<E>({
  app,
  source,
  catalog,
  editing,
  Failure,
  onCommitted,
}: {
  readonly app: App;
  readonly source: typeof AppSourceView.Type;
  readonly catalog?: AppSkillBundle;
  readonly editing: SkillEditing<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly onCommitted: (result: Committed) => void;
}) {
  const [selection, setSelection] = useState<Selection>();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState<Creating>();
  const [dirty, setDirty] = useState(false);
  const leave = () => !dirty || window.confirm("Discard your unsaved changes?");
  const owned: Skill[] = source.files.flatMap((file) => {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
    const name = match?.[1];
    if (name === undefined) return [];
    const prefix = `skills/${name}/`;
    return [
      {
        name,
        description: skillDescription(splitSkillDocument(file.content).frontmatter),
        files: source.files
          .filter((file) => file.path.startsWith(prefix))
          .map((file) => ({
            path: file.path.slice(prefix.length),
            content: file.content,
          })),
        editable: source.canEdit,
      },
    ];
  });
  const skills: readonly Skill[] = [
    ...owned,
    ...(catalog?.skills ?? [])
      .filter((skill) => !owned.some((local) => local.name === skill.name))
      .map((skill) => ({ ...skill, editable: false })),
  ];
  const current = skills.find((skill) => skill.name === selection?.skill) ?? skills[0];
  const file =
    current?.files.find((file) => file.path === selection?.file) ??
    current?.files.find((file) => file.path === "SKILL.md");
  const open = (skill: string, file: string) => {
    if (selection?.skill === skill && selection.file === file) return;
    if (!leave()) return;
    setSelection({ skill, file });
  };
  const create = (next: Creating) => {
    // Opening the form does not replace the current draft.
    setCreating(next);
  };
  const header = (actions?: ReactNode) => (
    <div className="sticky top-0 z-10 mb-6 flex min-h-12 flex-wrap items-center gap-3 border-b bg-background py-3 text-xs">
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <span>{current?.name}</span>
        <span aria-hidden>/</span>
        <span className="truncate text-foreground">
          {file?.path === "SKILL.md" ? "Instructions" : file?.path}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-1">{actions}</div>
    </div>
  );
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(120px,30%)_minmax(0,1fr)] min-[900px]:grid-cols-[260px_minmax(0,1fr)] min-[900px]:grid-rows-1">
      <aside className="flex min-h-0 flex-col border-b min-[900px]:border-b-0 min-[900px]:border-r">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
          <span className="text-xs font-medium text-muted-foreground">Skills</span>
          {source.canEdit && (
            <Button variant="ghost" size="xs" onClick={() => create({ kind: "skill" })}>
              <HugeiconsIcon icon={Add01Icon} size={14} aria-hidden /> New skill
            </Button>
          )}
        </div>
        <nav aria-label="Skill files" className="min-h-0 flex-1 overflow-y-auto p-2">
          {skills.map((skill) => {
            const expanded = !collapsed.has(skill.name);
            return (
              <div key={skill.name} className="mb-2">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(skill.name)) next.delete(skill.name);
                      else next.add(skill.name);
                      return next;
                    })
                  }
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-medium hover:bg-muted"
                >
                  <HugeiconsIcon
                    icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
                    size={13}
                    aria-hidden
                  />
                  <HugeiconsIcon
                    icon={skill.editable ? Folder01Icon : LockKeyIcon}
                    size={16}
                    className="shrink-0"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate" title={skill.name}>
                    {skill.name}
                  </span>
                  {!skill.editable && (
                    <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Read-only
                    </span>
                  )}
                </button>
                {expanded && (
                  <div className="ml-4 border-l pl-2">
                    {[...skill.files]
                      .sort((a, b) =>
                        a.path === "SKILL.md"
                          ? -1
                          : b.path === "SKILL.md"
                            ? 1
                            : a.path.localeCompare(b.path),
                      )
                      .map((item) => (
                        <button
                          key={item.path}
                          type="button"
                          title={item.path}
                          aria-current={
                            current?.name === skill.name && file?.path === item.path
                              ? "page"
                              : undefined
                          }
                          onClick={() => open(skill.name, item.path)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
                        >
                          <HugeiconsIcon icon={File01Icon} size={14} aria-hidden />
                          <span className="break-all">
                            {item.path === "SKILL.md" ? "Instructions" : item.path}
                          </span>
                        </button>
                      ))}
                    {skill.editable && (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="mt-1 w-full justify-start text-muted-foreground"
                        onClick={() => create({ kind: "file", skill: skill.name })}
                      >
                        <HugeiconsIcon icon={Add01Icon} size={13} aria-hidden /> Add file
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="min-h-0 min-w-0 overflow-y-auto px-5 pb-8 min-[900px]:px-10">
        {current === undefined || file === undefined ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-12 text-center">
            <h2 className="text-base font-medium">Give your app its first skill</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              Write instructions for agents, then add examples and references alongside them.
            </p>
            {source.canEdit && <Button onClick={() => create({ kind: "skill" })}>New skill</Button>}
          </div>
        ) : (
          <div className="max-w-3xl">
            {current.editable ? (
              <SkillFileEditor
                key={`${current.name}/${file.path}`}
                app={app}
                path={`skills/${current.name}/${file.path}`}
                skill={current.name}
                stored={file.content}
                editing={editing}
                Failure={Failure}
                header={header}
                reader={
                  <SkillContent
                    document={{
                      ...file,
                      file: file.path,
                      files: current.files.map((file) => file.path),
                    }}
                    onFile={(file) => open(current.name, file)}
                  />
                }
                onDirty={setDirty}
                onCommitted={onCommitted}
              />
            ) : (
              <>
                {header()}
                <p className="mb-4 text-xs text-muted-foreground">
                  This skill is read-only. Ask your agent to update it.
                </p>
                <SkillContent
                  document={{
                    ...file,
                    file: file.path,
                    files: current.files.map((file) => file.path),
                  }}
                  onFile={(file) => open(current.name, file)}
                />
              </>
            )}
          </div>
        )}
      </div>
      {creating !== undefined && (
        <CreateSkillFile
          key={JSON.stringify(creating)}
          app={app}
          creating={creating}
          source={source}
          skillNames={skills.map((skill) => skill.name)}
          editing={editing}
          Failure={Failure}
          onClose={() => setCreating(undefined)}
          onCreated={(selected, commit) => {
            setCreating(undefined);
            onCommitted({ commit, deploy: true });
            if (leave()) {
              setSelection(selected);
              setCollapsed((previous) => {
                const next = new Set(previous);
                next.delete(selected.skill);
                return next;
              });
            }
          }}
        />
      )}
    </div>
  );
}

function CreateSkillFile<E>({
  app,
  creating,
  source,
  skillNames,
  editing,
  Failure,
  onClose,
  onCreated,
}: {
  readonly app: App;
  readonly creating: Creating;
  readonly source: typeof AppSourceView.Type;
  readonly skillNames: readonly string[];
  readonly editing: SkillEditing<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly onClose: () => void;
  readonly onCreated: (selection: Selection, commit: string) => void;
}) {
  const isSkill = creating.kind === "skill";
  const [title, setTitle] = useState("");
  const [customIdentifier, setCustomIdentifier] = useState<string | null>(null);
  const generatedIdentifier = [
    ...title
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, ""),
  ]
    .slice(0, 64)
    .join("")
    .replace(/-+$/g, "");
  const name = isSkill ? (customIdentifier ?? generatedIdentifier) : title;
  const [settledName, setSettledName] = useState(name);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledName(name), 350);
    return () => window.clearTimeout(timer);
  }, [name]);
  const showValidation = settledName === name;
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const [conflict, setConflict] = useState(false);
  const commit = useAtomSet(editing.atoms.commitFile(app.id), { mode: "promiseExit" });
  const path = isSkill ? `skills/${name}/SKILL.md` : `skills/${creating.skill}/${name}`;
  const validName = isSkill
    ? name === name.toLowerCase() &&
      /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name) &&
      [...name].length <= 64
    : name.length > 0 &&
      !/[\\\0]/.test(name) &&
      name.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
      name !== "SKILL.md";
  const duplicate =
    source.files.some((file) => file.path === path) || (isSkill && skillNames.includes(name));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{isSkill ? "New skill" : "Add a file"}</DialogTitle>
        <DialogDescription>
          {isSkill
            ? "Give agents a reusable set of instructions."
            : `Add a reference, example or script to ${creating.skill}.`}
        </DialogDescription>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!validName || duplicate || (isSkill && !description.trim()) || pending) return;
            setPending(true);
            setError(undefined);
            setConflict(false);
            const content = isSkill
              ? `---\n${stringify({ name, description: description.trim() }, { lineWidth: 0 })}---\n\n`
              : "";
            const result = await commit({
              path,
              base: null,
              content,
              message: `Add ${isSkill ? `${name} skill` : name}`,
            });
            setPending(false);
            if (Exit.isFailure(result)) setError(result.cause);
            else if (result.value._tag === "FileChanged") setConflict(true);
            else
              onCreated(
                { skill: isSkill ? name : creating.skill, file: isSkill ? "SKILL.md" : name },
                result.value.commit,
              );
          }}
        >
          <label className="flex flex-col gap-2 text-sm">
            {isSkill ? "Name" : "File path"}
            <Input
              autoFocus
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setConflict(false);
              }}
              placeholder={isSkill ? "Summarize meetings" : "references/examples.md"}
              disabled={pending}
              required
            />
          </label>
          {isSkill && title && (
            <div className="space-y-2">
              {customIdentifier === null ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    Identifier: <code>{generatedIdentifier || "—"}</code>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={pending}
                    onClick={() => setCustomIdentifier(generatedIdentifier)}
                  >
                    Edit
                  </Button>
                </div>
              ) : (
                <div className="flex items-end gap-2">
                  <label className="flex min-w-0 flex-1 flex-col gap-2 text-xs text-muted-foreground">
                    Identifier
                    <Input
                      value={customIdentifier}
                      disabled={pending}
                      required
                      onChange={(event) => {
                        setCustomIdentifier(event.target.value);
                        setConflict(false);
                      }}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      setCustomIdentifier(null);
                      setConflict(false);
                    }}
                  >
                    Use name
                  </Button>
                </div>
              )}
            </div>
          )}
          {isSkill && (
            <label className="flex flex-col gap-2 text-sm">
              Description
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="When should an agent use this skill?"
                rows={3}
                maxLength={1024}
                disabled={pending}
                required
              />
            </label>
          )}
          {title && showValidation && !validName && (
            <p role="alert" className="text-xs text-destructive">
              {isSkill
                ? customIdentifier === null
                  ? "Add a letter or number to the name to create an identifier."
                  : "Use lowercase letters, numbers and single hyphens, up to 64 characters."
                : "Use a relative path without empty folders or dot segments. Choose a name other than SKILL.md."}
            </p>
          )}
          {((showValidation && duplicate) || conflict) && (
            <p role="alert" className="text-xs text-destructive">
              That {isSkill ? "identifier" : "file"} already exists. Choose another{" "}
              {isSkill ? "name or edit the identifier" : "name"}.
            </p>
          )}
          {error && <Failure cause={error} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button
              loading={pending}
              disabled={!validName || duplicate || (isSkill && !description.trim())}
            >
              {isSkill ? "Create skill" : "Create file"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
