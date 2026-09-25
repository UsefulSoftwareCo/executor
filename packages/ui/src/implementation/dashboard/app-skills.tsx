import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu.tsx";
import { useState, type ComponentType, type ReactNode } from "react";
import { BookOpen01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { App, AppSkillBundle, AppSkillDocument } from "@executor-js/sdk";
import type { SkillBindings } from "../../contracts/app-browser.ts";
import type { FailureProps } from "../../contracts/dashboard.ts";
import { Option } from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import type { AppSourceView } from "@executor-js/app-management/contracts";
import { QueryView, useQuery } from "./context.tsx";
import { SkillBrowserLoading } from "./app-browser-loading.tsx";
import { CopyButton } from "./code.tsx";
import { EmptyStatePanel } from "./empty-state.tsx";
import { Button } from "../components/button.tsx";
import { SkillContent } from "./skill-content.tsx";
import {
  SkillDeployment,
  SkillFileEditor,
  type Committed,
  type SkillEditing,
} from "./skill-editor.tsx";

import { SkillWorkspace } from "./skill-workspace.tsx";

type Skill = AppSkillBundle["skills"][number];

/** All skill documents and references load together; selection never starts another request. */
export function AppSkills<E>({
  app,
  bindings,
  Failure,
  canEdit,
  editing,
}: {
  readonly app: App;
  readonly canEdit: boolean;
  readonly bindings: SkillBindings<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
  /** Present when this viewer may manage app source; the server still authorizes each commit. */
  readonly editing?: SkillEditing<E> | undefined;
}) {
  // Outside the catalog query, so the status and its deploy survive the catalog reloading.
  const [committed, setCommitted] = useState<Committed>();
  return (
    <section aria-label="App skills" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {committed !== undefined && editing !== undefined && (
        <SkillDeployment
          key={committed.commit}
          app={app}
          commit={committed.commit}
          deployNow={committed.deploy}
          onStarted={() => setCommitted({ ...committed, deploy: false })}
          editing={editing}
          Failure={Failure}
        />
      )}
      {editing !== undefined && canEdit ? (
        <QueryView
          query={editing.atoms.workspace(app.id)}
          Failure={Failure}
          pending={<SkillBrowserLoading />}
        >
          {(source) => (
            <EditableSkills
              app={app}
              source={source}
              bindings={bindings}
              editing={editing}
              Failure={Failure}
              onCommitted={setCommitted}
            />
          )}
        </QueryView>
      ) : app.activeDeployment === null ? (
        <EmptyStatePanel title="No deployment yet">
          The app owner needs to deploy this app before its skills are available.
        </EmptyStatePanel>
      ) : (
        <QueryView query={bindings.bundle} Failure={Failure} pending={<SkillBrowserLoading />}>
          {(catalog) => (
            <SkillCatalog
              app={app}
              catalog={catalog}
              canEdit={false}
              editing={undefined}
              Failure={Failure}
              onCommitted={setCommitted}
            />
          )}
        </QueryView>
      )}
    </section>
  );
}
const undeployedCatalog = Atom.make(AsyncResult.success(undefined));

function EditableSkills<E>({
  app,
  source,
  bindings,
  editing,
  Failure,
  onCommitted,
}: {
  readonly app: App;
  readonly source: typeof AppSourceView.Type;
  readonly bindings: SkillBindings<E>;
  readonly editing: SkillEditing<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly onCommitted: (result: Committed) => void;
}) {
  const { result, data, refresh } = useQuery<AppSkillBundle | undefined, E>(
    app.activeDeployment === null ? undeployedCatalog : bindings.bundle,
  );
  // The catalog atom is keyed by deployment, so every deploy (including the one after Save)
  // starts a new atom at Initial. Keep the last loaded catalog until the new one arrives;
  // replacing the workspace with the skeleton would remount the open editor.
  const loaded = AsyncResult.isInitial(result)
    ? undefined
    : { catalog: Option.getOrUndefined(data) };
  const [settled, setSettled] = useState(loaded);
  if (loaded !== undefined && (settled === undefined || loaded.catalog !== settled.catalog))
    setSettled(loaded);
  // Deployed skills may exist only in the catalog. Until it first arrives, the list is incomplete
  // and an app with only remote skills would look empty.
  const shown = loaded ?? settled;
  if (shown === undefined) return <SkillBrowserLoading />;
  const catalog = shown.catalog;
  return (
    <>
      {AsyncResult.isFailure(result) && (
        <Failure cause={result.cause} retry={refresh} retrying={result.waiting} />
      )}
      <SkillWorkspace
        app={app}
        source={source}
        {...(catalog === undefined ? {} : { catalog })}
        editing={editing}
        Failure={Failure}
        onCommitted={onCommitted}
      />
    </>
  );
}

function SkillCatalog<E>({
  app,
  catalog,
  canEdit,
  editing,
  Failure,
  onCommitted,
}: {
  readonly app: App;
  readonly catalog: AppSkillBundle;
  readonly canEdit: boolean;
  readonly editing: SkillEditing<E> | undefined;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly onCommitted: (result: Committed) => void;
}) {
  const [selected, setSelected] = useState<string>();
  // An open draft asks before another skill or file replaces it.
  const [dirty, setDirty] = useState(false);
  const leave = () => !dirty || window.confirm("Discard your unsaved changes?");
  const current = catalog.skills.find((skill) => skill.name === selected) ?? catalog.skills[0];
  if (current === undefined)
    return (
      <EmptyStatePanel
        title="No skills yet"
        icon={<HugeiconsIcon icon={BookOpen01Icon} aria-hidden size={26} strokeWidth={1.3} />}
        action={
          canEdit ? (
            <CopyButton
              code={`Add skills to my Executor app ${JSON.stringify(app.name)} (app ID: ${app.id}). Review its source and tools, then write concise instructions for its main workflows in skills/<skill-name>/SKILL.md with valid name and description frontmatter. Deploy the updated app and verify that its skills are listed.`}
              label="Copy prompt"
              text="Copy prompt"
              variant="default"
              size="default"
              inline
            />
          ) : (
            <Button disabledReason="You need permission to edit this app’s source to add skills.">
              Copy prompt
            </Button>
          )
        }
      >
        {canEdit
          ? "Copy this prompt and paste it into your agent to add skills for this app."
          : "The app owner can add skills for its common tasks."}
      </EmptyStatePanel>
    );
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(100px,25%)_minmax(0,1fr)] min-[900px]:grid-cols-[240px_minmax(0,1fr)] min-[900px]:grid-rows-1">
      <nav
        aria-label="Skills"
        className="flex min-h-0 gap-1 overflow-auto border-b p-3 min-[900px]:block min-[900px]:border-b-0 min-[900px]:border-r"
      >
        {catalog.skills.map((skill) => (
          <button
            type="button"
            key={skill.name}
            onClick={() => {
              if (skill.name !== current.name && leave()) setSelected(skill.name);
            }}
            aria-current={current.name === skill.name ? "true" : undefined}
            className="shrink-0 rounded-md px-3 py-2.5 text-left hover:bg-muted aria-[current=true]:bg-muted min-[900px]:w-full"
          >
            <span className="block break-words text-sm font-medium">{skill.name}</span>
            <span className="mt-1 hidden text-xs leading-5 text-muted-foreground min-[900px]:block">
              {skill.description}
            </span>
          </button>
        ))}
      </nav>
      <SkillFiles
        key={current.name}
        app={app}
        skill={current}
        catalog={catalog}
        editing={editing}
        Failure={Failure}
        leave={leave}
        onDirty={setDirty}
        onCommitted={onCommitted}
      />
    </div>
  );
}
function SkillFiles<E>({
  app,
  skill,
  catalog,
  editing,
  Failure,
  leave,
  onDirty,
  onCommitted,
}: {
  readonly app: App;
  readonly skill: Skill;
  readonly catalog: AppSkillBundle;
  readonly editing: SkillEditing<E> | undefined;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly leave: () => boolean;
  readonly onDirty: (dirty: boolean) => void;
  readonly onCommitted: (result: Committed) => void;
}) {
  const [file, setFile] = useState("SKILL.md");
  const open = (next: string) => {
    if (next !== file && leave()) setFile(next);
  };
  const resource = skill.files.find((item) => item.path === file);
  if (resource === undefined)
    return (
      <p role="alert" className="p-5 text-sm">
        This skill file is unavailable.
      </p>
    );
  const document: AppSkillDocument = {
    ...skill,
    revision: catalog.revision,
    ...(catalog.profile === undefined ? {} : { profile: catalog.profile }),
    ...(catalog.profileRevision === undefined ? {} : { profileRevision: catalog.profileRevision }),
    app: catalog.app,
    deployment: catalog.deployment,
    file: resource.path,
    content: resource.content,
    files: skill.files.map((item) => item.path),
  };
  const header = (actions?: ReactNode) => (
    <div className="sticky top-0 z-10 mb-6 flex min-h-9 flex-wrap items-center justify-between gap-3 border-b bg-background pb-3 text-xs">
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <button
          type="button"
          className="shrink-0 hover:text-foreground"
          aria-label="Back to instructions"
          onClick={() => open("SKILL.md")}
        >
          {skill.name}
        </button>
        <span aria-hidden>/</span>
        <span aria-label="Current skill file" className="truncate text-foreground">
          {file === "SKILL.md" ? "Instructions" : file.split("/").at(-1)}
        </span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {actions}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              Files <span className="text-muted-foreground">{skill.files.length}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={file} onValueChange={open}>
              {skill.files.map((item) => (
                <DropdownMenuRadioItem key={item.path} value={item.path}>
                  {item.path === "SKILL.md" ? "Instructions" : item.path}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
  const reader = <SkillContent document={document} onFile={open} />;
  const path = `skills/${skill.name}/${file}`;
  return (
    <div className="min-h-0 min-w-0 overflow-y-auto px-5 pb-5 min-[900px]:px-10">
      <div className="max-w-3xl pt-5">
        {editing === undefined || !/\.md$/i.test(file) ? (
          <>
            {header()}
            {reader}
          </>
        ) : (
          <QueryView
            query={editing.atoms.workspace(app.id)}
            Failure={Failure}
            pending={
              <>
                {header()}
                {reader}
              </>
            }
          >
            {(source) => {
              const stored = source.files.find((item) => item.path === path);
              // Skills from code or remote sources, and apps this person cannot change, stay read-only.
              if (stored === undefined || !source.canEdit)
                return (
                  <>
                    {header()}
                    {reader}
                  </>
                );
              return (
                <SkillFileEditor
                  key={path}
                  app={app}
                  path={path}
                  skill={skill.name}
                  stored={stored.content}
                  editing={editing}
                  Failure={Failure}
                  header={header}
                  reader={reader}
                  onDirty={onDirty}
                  onCommitted={onCommitted}
                />
              );
            }}
          </QueryView>
        )}
      </div>
    </div>
  );
}
