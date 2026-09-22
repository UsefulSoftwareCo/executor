import { useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import type { App } from "@executor-js/sdk";
import type { AppSourceView } from "@executor-js/app-management/contracts";
import {
  type PublicationReadiness,
  type PublicationIssue,
  registryPublicationPath,
} from "@executor-js/app-registry/contracts";
import { HugeiconsIcon } from "@hugeicons/react";
import { Globe02Icon, LockKeyIcon, Tick02Icon, Upload04Icon } from "@hugeicons/core-free-icons";
import type { AppManagementProps } from "../../contracts/app-management.ts";
import { Button } from "../components/button.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/dialog.tsx";
import { ProviderIcon } from "./common.tsx";
import { QueryView } from "./context.tsx";

type PublishableSource = Omit<typeof AppSourceView.Type, "publication"> & {
  readonly publication: typeof PublicationReadiness.Type;
};

function publicationRepair(issue: PublicationIssue) {
  switch (issue.reason) {
    case "missing-manifest":
      return {
        title: "Add a package name",
        detail: "This app has no package.json file.",
        rename: true,
      };
    case "missing-name":
      return {
        title: "Add a package name",
        detail: "package.json does not contain a name.",
        rename: true,
      };
    case "unscoped-name":
      return {
        title: "Add your publishing handle",
        detail: "This package has a name, but public names also need your organization’s handle.",
        rename: true,
      };
    case "invalid-name":
      return {
        title: "Use a valid public name",
        detail: "Public names use @handle/app-name with lowercase letters, numbers, and hyphens.",
        rename: true,
      };
    case "forbidden-scope":
      return {
        title: "Use your own publishing handle",
        detail: "This organization cannot publish under the handle in this name.",
        rename: true,
      };
    case "name-taken":
      return {
        title: "Choose a different public name",
        detail: "Another app already uses this public name. This copy needs its own name.",
        rename: true,
      };
    case "invalid-json":
      return {
        title: "Fix package.json",
        detail:
          "The file must contain a valid JSON object. Ask your agent to repair it before publishing.",
        rename: false,
      };
    case "invalid-metadata":
      return {
        title: "Check the package details",
        detail:
          "The name is valid, but other package details are not. Ask your agent to check the description and Executor settings.",
        rename: false,
      };
    case "unsupported-dependencies":
      return {
        title: "Include the required app code",
        detail:
          "App-to-app package dependencies are not supported. Ask your agent to make this package self-contained.",
        rename: false,
      };
    case "invalid-source":
      return {
        title: "Review the files to publish",
        detail:
          "The source includes files that cannot be published, such as .env, .npmrc, or node_modules. Ask your agent to remove them from the saved app source.",
        rename: false,
      };
    case "limit":
      return {
        title: "Reduce the package size",
        detail:
          "Public apps can contain up to 512 files and 4 MB of source. Ask your agent to remove files the app does not need.",
        rename: false,
      };
  }
}

function PublicationProblem({
  issue,
  suggestedName,
}: Extract<typeof PublicationReadiness.Type, { status: "blocked" }>) {
  const repair = publicationRepair(issue);
  return (
    <div className="rounded-lg border p-5" role="alert">
      <p className="text-sm font-medium">{repair.title}</p>
      {issue.name !== null && (
        <p className="mt-2 break-words text-sm">
          Current name: <code>{issue.name}</code>
        </p>
      )}
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{repair.detail}</p>
      {repair.rename && suggestedName !== null && (
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Ask your agent to set <code>name</code> in <code>package.json</code> to{" "}
          <code className="break-all">{suggestedName}</code>.
        </p>
      )}
    </div>
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
          <Button variant="outline" disabledReason="Publishing is not available on this server.">
            Publish
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
  const publishing = useAtomValue(atoms.publish(app.id));
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <HugeiconsIcon icon={Upload04Icon} size={16} strokeWidth={1.8} aria-hidden />
        Publish
      </Button>
      <Dialog
        open={open}
        onOpenChange={(open) => {
          if (!publishing.waiting) setOpen(open);
        }}
      >
        {open && (
          <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-xl">
            <div className="px-7 pb-6 pt-7 max-[740px]:px-5">
              <DialogTitle className="pr-5 text-2xl leading-tight tracking-tight">
                Publish {app.name}
              </DialogTitle>
              <DialogDescription className="mt-2 leading-6">
                Share your app so anyone can find it and make their own copy.
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
                source.publication !== null ? (
                  <PublishDialog
                    app={app}
                    source={{ ...source, publication: source.publication }}
                    atoms={atoms}
                    Failure={Failure}
                    onClose={() => setOpen(false)}
                  />
                ) : (
                  <p className="px-7 pb-6 text-sm">Publishing is not available for this app.</p>
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
}: AppManagementProps<E> & {
  readonly app: App;
  readonly source: PublishableSource;
  readonly onClose: () => void;
}) {
  const [source] = useState(initialSource);
  const manifest = source.publication.status === "ready" ? source.publication.manifest : undefined;
  return (
    <>
      <div className="px-7 pb-6 max-[740px]:px-5">
        {source.publication.status === "blocked" ? (
          <PublicationProblem {...source.publication} />
        ) : (
          <>
            <p className="mb-3 text-xs font-medium text-muted-foreground">Your app’s listing</p>
            <div className="flex items-start gap-4 rounded-xl border bg-muted/15 p-5">
              <ProviderIcon name={source.publication.manifest.name} large />
              <div className="min-w-0 py-0.5">
                <p className="break-words text-base font-semibold tracking-tight">
                  {source.publication.manifest.name}
                </p>
                {source.publication.manifest.description && (
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {source.publication.manifest.description}
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
      {manifest === undefined ? (
        <div className="flex justify-end border-t bg-muted/10 px-7 py-4 max-[740px]:px-5">
          <Button onClick={onClose}>Done</Button>
        </div>
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
              name={manifest.name}
              publishedCommit={publications.find((item) => item.name === manifest.name)?.commit}
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
              {completed === "unpublished" ? "App unpublished" : "Your app is published"}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {completed === "unpublished"
                ? "It no longer appears in discovery. Existing copies keep working."
                : completed === "published"
                  ? "People can find it in Add app and make their own copy."
                  : "Your latest saved changes are already published."}
            </p>
          </div>
        </div>
      )}
      {publishedCommit !== undefined && !current && completed === null && (
        <p className="border-t px-7 py-4 text-sm leading-6 text-muted-foreground max-[740px]:px-5">
          Publish your latest saved changes as the new public version. Existing copies stay as they
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
            View published app <span aria-hidden>↗</span>
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
              Unpublish
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
                  ? "Publishing…"
                  : publishedCommit === undefined
                    ? "Publish app"
                    : "Publish new version"}
              </Button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
