import { useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit, Schema, type Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import {
  registryPublicationPath,
  type App,
  type PublicationIssue,
  type PublicationReadiness,
} from "@executor-js/sdk";
import type { AppSourceDisplay } from "@executor-js/app-management/contracts";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowRight02Icon,
  Globe02Icon,
  LockKeyIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { AppManagementProps } from "../../contracts/app-management.ts";
import { Button } from "../components/button.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/dialog.tsx";
import { CopyButton } from "./code.tsx";
import { ProviderIcon } from "./common.tsx";
import { QueryView, useQuery } from "./context.tsx";
import { cn } from "../lib/utils.ts";

type PublishableSource = Omit<typeof AppSourceDisplay.Type, "publication"> & {
  readonly publication: typeof PublicationReadiness.Type;
};

const scopeOf = (name: string) => name.slice(0, name.indexOf("/"));

const nameTask = (reason: PublicationIssue["reason"], suggestedName: string | null) =>
  suggestedName === null
    ? 'Set "name" in package.json to a public name of the form @handle/app-name, using this organization’s publishing handle.'
    : reason === "missing-manifest"
      ? `Add a package.json file whose "name" is "${suggestedName}".`
      : `Set "name" in package.json to "${suggestedName}" and leave the other fields unchanged.`;

/** A self-contained request an agent with this app's source tools can act on. */
const agentPrompt = (app: App, repair: ReturnType<typeof publicationRepair>) =>
  `The Executor app "${app.name}" (${app.id}) can't be published yet. ${repair.title}: ${repair.detail}

${repair.task} Commit the change to the app's working source. Don't deploy or publish the app.`;

function publicationRepair(issue: PublicationIssue, suggestedName: string | null) {
  switch (issue.reason) {
    case "missing-manifest":
      return {
        title: "Add a package name",
        detail: "This app has no package.json file.",
        rename: true,
        task: nameTask(issue.reason, suggestedName),
      };
    case "missing-name":
      return {
        title: "Add a package name",
        detail: "package.json does not contain a name.",
        rename: true,
        task: nameTask(issue.reason, suggestedName),
      };
    case "unscoped-name":
      return {
        title: "Add your publishing handle",
        detail: "This package has a name, but public names also need your organization’s handle.",
        rename: true,
        task: nameTask(issue.reason, suggestedName),
      };
    case "invalid-name":
      return {
        title: "Use a valid public name",
        detail: "Public names use @handle/app-name with lowercase letters, numbers, and hyphens.",
        rename: true,
        task: nameTask(issue.reason, suggestedName),
      };
    case "forbidden-scope":
      return {
        title: "This name uses another publishing handle",
        detail:
          issue.name !== null && suggestedName !== null
            ? `Apps from this organization are published under ${scopeOf(suggestedName)}. The name in package.json starts with ${scopeOf(issue.name)}, which this organization cannot publish under.`
            : "The name in package.json starts with a handle this organization cannot publish under.",
        rename: true,
        task: nameTask(issue.reason, suggestedName),
      };
    case "name-taken":
      return {
        title: "Choose a different public name",
        detail: "Another app already uses this public name. This copy needs its own name.",
        rename: true,
        task: nameTask(issue.reason, suggestedName),
      };
    case "invalid-json":
      return {
        title: "Fix package.json",
        detail: "package.json must contain a valid JSON object.",
        rename: false,
        task: "Repair package.json so it is a valid JSON object, keeping its existing fields.",
      };
    case "invalid-metadata":
      return {
        title: "Check the package details",
        detail: "The name is valid, but other package details are not.",
        rename: false,
        task: "Check the description and executor fields in package.json and fix any that are invalid. The description can be at most 2,000 characters.",
      };
    case "unsupported-dependencies":
      return {
        title: "Include the required app code",
        detail: "App-to-app package dependencies are not supported.",
        rename: false,
        task: "Remove executor.dependencies from package.json and include the code the app needs directly in its source.",
      };
    case "invalid-source":
      return {
        title: "Review the files to publish",
        detail:
          "The source includes files that cannot be published, such as .env, .npmrc, or node_modules.",
        rename: false,
        task: "Remove files that cannot be published (.env files, .npmrc, node_modules, .git, .executor, executor.lock.json) from the saved app source.",
      };
    case "limit":
      return {
        title: "Reduce the package size",
        detail: "Public apps can contain up to 512 files and 4 MB of source.",
        rename: false,
        task: "Remove files the app does not need so its saved source has at most 512 files and 4 MB.",
      };
  }
}

const PackageJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

/** Set only the package name; every other package.json field keeps its value and order. */
const renamedPackage = (content: string | null, name: string) => {
  if (content === null) return `${JSON.stringify({ name }, null, 2)}\n`;
  const manifest = Schema.decodeUnknownSync(PackageJson)(content);
  return `${JSON.stringify("name" in manifest ? { ...manifest, name } : { name, ...manifest }, null, 2)}\n`;
};

function PublicationProblem({
  issue,
  suggestedName,
}: Extract<typeof PublicationReadiness.Type, { status: "blocked" }>) {
  const repair = publicationRepair(issue, suggestedName);
  const rename = repair.rename && suggestedName !== null;
  return (
    <div
      className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-5 dark:border-amber-400/30"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <HugeiconsIcon
          icon={Alert02Icon}
          size={18}
          className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-sm font-medium">This app can’t be shared publicly yet</p>
          <p className="mt-1 text-sm">{repair.title}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{repair.detail}</p>
        </div>
      </div>
      {rename ? (
        <div className="mt-4 space-y-2 rounded-md border bg-background/60 p-3 text-sm">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">Current</span>
            {issue.name === null ? (
              <span className="text-muted-foreground">No name</span>
            ) : (
              <code className="break-all text-muted-foreground line-through decoration-muted-foreground/60">
                {issue.name}
              </code>
            )}
          </p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">New</span>
            <code className="break-all font-medium">{suggestedName}</code>
          </p>
        </div>
      ) : (
        issue.name !== null && (
          <p className="mt-3 break-words text-sm">
            Current name: <code>{issue.name}</code>
          </p>
        )
      )}
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        {rename ? (
          <>
            Renaming saves a new version of <code>package.json</code>. It doesn’t change the running
            app or its connected accounts. You can also copy a prompt and have your agent do it.
          </>
        ) : (
          "Copy a prompt and have your agent fix this, then open Share publicly again."
        )}
      </p>
    </div>
  );
}

function CopyPrompt({ prompt }: { readonly prompt: string }) {
  return (
    <CopyButton
      code={prompt}
      label="Copy prompt for your agent"
      text="Copy prompt"
      variant="outline"
      size="default"
      inline
    />
  );
}

/** Save the suggested name as a normal source commit, then hand the new revision back for review. */
function RenameAndContinue<E>({
  app,
  suggestedName,
  atoms,
  Failure,
  onClose,
  onRenamed,
  prompt,
}: AppManagementProps<E> & {
  readonly app: App;
  readonly suggestedName: string;
  readonly prompt: string;
  readonly onClose: () => void;
  readonly onRenamed: (commit: string) => void;
}) {
  const { result: workspace, refresh } = useQuery(atoms.workspace(app.id));
  const commit = useAtomSet(atoms.commitFile(app.id), { mode: "promiseExit" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const [changed, setChanged] = useState(false);
  const loaded = AsyncResult.isSuccess(workspace);
  const rename = async () => {
    if (!AsyncResult.isSuccess(workspace)) return;
    const base =
      workspace.value.files.find((file) => file.path === "package.json")?.content ?? null;
    setSaving(true);
    setError(undefined);
    setChanged(false);
    const result = await commit({
      path: "package.json",
      base,
      content: renamedPackage(base, suggestedName),
      message: `Rename package to ${suggestedName}`,
    });
    setSaving(false);
    if (Exit.isFailure(result)) setError(result.cause);
    else if (result.value._tag === "FileChanged") setChanged(true);
    else onRenamed(result.value.commit);
  };
  return (
    <>
      {AsyncResult.isFailure(workspace) && (
        <Failure cause={workspace.cause} retry={refresh} retrying={workspace.waiting} />
      )}
      {error !== undefined && <Failure cause={error} />}
      {changed && (
        <p className="border-t px-7 py-4 text-sm leading-6 max-[740px]:px-5" role="alert">
          package.json changed while this was open. Close this dialog and try again.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/10 px-7 py-4 max-[740px]:px-5">
        <div className="mr-auto">
          <CopyPrompt prompt={prompt} />
        </div>
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          className="min-w-32"
          loading={saving || (!loaded && workspace.waiting)}
          disabled={!loaded || saving || changed}
          onClick={rename}
        >
          {saving ? "Renaming…" : "Rename and continue"}
          {!saving && <HugeiconsIcon icon={ArrowRight02Icon} size={16} aria-hidden />}
        </Button>
      </div>
    </>
  );
}

/** Make publishing available from every app tab; the host still owns permission. */
export function PublishApp<E>({
  app,
  atoms,
  Failure,
}: AppManagementProps<E> & { readonly app: App }) {
  return (
    <QueryView
      query={atoms.authoring(app.id)}
      Failure={Failure}
      pending={
        <Skeleton className="h-9 w-26 max-[740px]:h-11" aria-label="Loading publishing access" />
      }
    >
      {(metadata) =>
        metadata.canPublish ? (
          <PublishAction app={app} atoms={atoms} Failure={Failure} />
        ) : (
          <Button
            variant="outline"
            disabledReason="Public sharing is not available on this server."
          >
            Share publicly
          </Button>
        )
      }
    </QueryView>
  );
}

/** Source and publication reads begin only when someone opens the publishing dialog. */
function PublishAction<E>({
  app,
  atoms,
  Failure,
}: AppManagementProps<E> & {
  readonly app: App;
}) {
  const [open, setOpen] = useState(false);
  // After an in-dialog rename, review the saved revision instead of the one first opened.
  const [renamed, setRenamed] = useState<string | null>(null);
  const publishing = useAtomValue(atoms.publish(app.id));
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <HugeiconsIcon icon={Globe02Icon} size={16} strokeWidth={1.8} aria-hidden />
        Share publicly
      </Button>
      <Dialog
        open={open}
        onOpenChange={(open) => {
          if (publishing.waiting) return;
          setOpen(open);
          if (!open) setRenamed(null);
        }}
      >
        {open && (
          <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-xl">
            <div className="px-7 pb-6 pt-7 max-[740px]:px-5">
              <DialogTitle className="pr-5 text-2xl leading-tight tracking-tight">
                Share {app.name} publicly
              </DialogTitle>
              <DialogDescription className="mt-2 leading-6">
                List your app in Add app so anyone can find it and make their own copy.
              </DialogDescription>
            </div>
            <QueryView
              query={atoms.source(app.id)}
              Failure={(props) => (
                <div className="px-7 pb-6">
                  <Failure {...props} />
                </div>
              )}
              pending={
                <div className="px-7 pb-6">
                  <Skeleton className="h-32 w-full" aria-label="Loading publication details" />
                </div>
              }
            >
              {(source) =>
                renamed !== null && source.revision.commit !== renamed ? (
                  <div className="px-7 pb-6" role="status">
                    <Skeleton className="h-32 w-full" aria-label="Checking the new name" />
                  </div>
                ) : source.publication !== null ? (
                  <PublishDialog
                    key={renamed ?? "opened"}
                    app={app}
                    source={{ ...source, publication: source.publication }}
                    atoms={atoms}
                    Failure={Failure}
                    onClose={() => {
                      setOpen(false);
                      setRenamed(null);
                    }}
                    onRenamed={setRenamed}
                  />
                ) : (
                  <p className="px-7 pb-6 text-sm">Public sharing is not available for this app.</p>
                )
              }
            </QueryView>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

/** Keep the reviewed revision fixed while the dialog is open, including during source refreshes. */
function PublishDialog<E>({
  app,
  source: initialSource,
  atoms,
  Failure,
  onClose,
  onRenamed,
}: AppManagementProps<E> & {
  readonly app: App;
  readonly source: PublishableSource;
  readonly onClose: () => void;
  readonly onRenamed: (commit: string) => void;
}) {
  const [source] = useState(initialSource);
  const { publication } = source;
  const repair =
    publication.status === "blocked"
      ? publicationRepair(publication.issue, publication.suggestedName)
      : undefined;
  return (
    <>
      <div className="px-7 pb-6 max-[740px]:px-5">
        {publication.status === "blocked" ? (
          <PublicationProblem {...publication} />
        ) : (
          <>
            <p className="mb-3 text-xs font-medium text-muted-foreground">Your app’s listing</p>
            <div
              className={cn(
                "flex gap-4 rounded-xl border bg-muted/15 p-5",
                publication.manifest.description ? "items-start" : "items-center",
              )}
            >
              <ProviderIcon name={publication.manifest.name} large />
              <div className={cn("min-w-0", publication.manifest.description && "py-0.5")}>
                <p className="break-words text-base font-semibold tracking-tight">
                  {publication.manifest.name}
                </p>
                {publication.manifest.description && (
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {publication.manifest.description}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-5 space-y-3 text-[13px] leading-5">
              <p className="flex items-start gap-3">
                <HugeiconsIcon
                  icon={Globe02Icon}
                  size={17}
                  className="mt-0.5 shrink-0"
                  aria-hidden
                />
                Your latest saved app files will be public.
              </p>
              <p className="flex items-start gap-3 text-muted-foreground">
                <HugeiconsIcon
                  icon={LockKeyIcon}
                  size={17}
                  className="mt-0.5 shrink-0"
                  aria-hidden
                />
                Connected accounts and app data stay private.
              </p>
            </div>
          </>
        )}
      </div>
      {publication.status === "blocked" ? (
        repair?.rename && publication.suggestedName !== null ? (
          <RenameAndContinue
            app={app}
            suggestedName={publication.suggestedName}
            atoms={atoms}
            Failure={Failure}
            onClose={onClose}
            onRenamed={onRenamed}
            prompt={agentPrompt(app, repair)}
          />
        ) : (
          <div className="flex items-center justify-between gap-2 border-t bg-muted/10 px-7 py-4 max-[740px]:px-5">
            {repair !== undefined && <CopyPrompt prompt={agentPrompt(app, repair)} />}
            <Button onClick={onClose}>OK</Button>
          </div>
        )
      ) : (
        <QueryView
          query={atoms.published}
          Failure={Failure}
          pending={
            <div
              className="flex items-center justify-between border-t px-7 py-4 max-[740px]:px-5"
              role="status"
            >
              <span className="text-sm text-muted-foreground">Checking publication…</span>
              <Skeleton className="h-9 w-28 max-[740px]:h-11" />
            </div>
          }
        >
          {(publications) => (
            <PublicationActions
              app={app}
              source={source}
              name={publication.manifest.name}
              publishedCommit={
                publications.find((item) => item.name === publication.manifest.name)?.commit
              }
              atoms={atoms}
              Failure={Failure}
              onClose={onClose}
            />
          )}
        </QueryView>
      )}
    </>
  );
}

/** Confirm successful writes and keep their result visible while registry reads reconcile. */
function PublicationActions<E>({
  app,
  source,
  name,
  publishedCommit,
  atoms,
  Failure,
  onClose,
}: AppManagementProps<E> & {
  readonly app: App;
  readonly source: PublishableSource;
  readonly name: string;
  readonly publishedCommit: string | undefined;
  readonly onClose: () => void;
}) {
  const publishing = useAtomValue(atoms.publish(app.id));
  const publish = useAtomSet(atoms.publish(app.id), { mode: "promiseExit" });
  const removing = useAtomValue(atoms.unpublish(name));
  const unpublish = useAtomSet(atoms.unpublish(name), { mode: "promiseExit" });
  const [attempted, setAttempted] = useState<"publish" | "unpublish" | null>(null);
  const [completed, setCompleted] = useState<"published" | "unpublished" | null>(null);
  const pending = publishing.waiting || removing.waiting;
  const current = publishedCommit === source.revision.commit;
  return (
    <>
      {attempted === "publish" && AsyncResult.isFailure(publishing) && (
        <Failure cause={publishing.cause} />
      )}
      {attempted === "unpublish" && AsyncResult.isFailure(removing) && (
        <Failure cause={removing.cause} />
      )}
      {(completed !== null || current) && (
        <div
          className="flex items-start gap-3 border-t px-7 py-4 text-sm max-[740px]:px-5"
          role="status"
        >
          <HugeiconsIcon icon={Tick02Icon} size={18} className="mt-0.5 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">
              {completed === "unpublished" ? "Stopped sharing" : "Your app is listed publicly"}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {completed === "unpublished"
                ? "It no longer appears in Add app. Existing copies keep working."
                : completed === "published"
                  ? "People can find it in Add app and make their own copy."
                  : "Your latest saved changes are already shared."}
            </p>
          </div>
        </div>
      )}
      {publishedCommit !== undefined && !current && completed === null && (
        <p className="border-t px-7 py-4 text-sm leading-6 text-muted-foreground max-[740px]:px-5">
          Share your latest saved changes as the new public version. Existing copies stay as they
          are.
        </p>
      )}
      {publishedCommit !== undefined && completed !== "unpublished" && (
        <div className="px-7 pb-5 max-[740px]:px-5">
          <a
            href={registryPublicationPath(name)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-9 items-center gap-2 text-sm font-medium underline underline-offset-4 hover:text-muted-foreground"
          >
            View public listing <span aria-hidden>↗</span>
          </a>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 border-t bg-muted/10 px-7 py-4 max-[740px]:px-5">
        <div>
          {publishedCommit !== undefined && completed === null && (
            <Button
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              loading={removing.waiting}
              disabled={pending}
              onClick={async () => {
                setAttempted("unpublish");
                const result = await unpublish();
                if (Exit.isSuccess(result)) setCompleted("unpublished");
              }}
            >
              Stop sharing
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {completed !== null || current ? (
            <Button onClick={onClose} disabled={pending} className="min-w-24">
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button
                className="min-w-32"
                loading={publishing.waiting}
                disabled={pending}
                onClick={async () => {
                  setAttempted("publish");
                  const result = await publish(source.revision.commit);
                  if (Exit.isSuccess(result)) setCompleted("published");
                }}
              >
                {publishing.waiting
                  ? "Sharing…"
                  : publishedCommit === undefined
                    ? "List publicly"
                    : "Update public listing"}
              </Button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
