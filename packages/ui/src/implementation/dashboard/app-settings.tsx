import { AppSectionHeader, AppSectionTitle } from "./app-section-header.tsx";
import type { App } from "@executor-js/sdk";
import type { ReactNode } from "react";

/** App metadata and removal live together; products supply only the actions they authorize. */
export function AppSettings({
  app,
  renameAction,
  deleteAction,
  notice,
  children,
}: {
  readonly app: App;
  readonly renameAction?: ReactNode;
  readonly deleteAction?: ReactNode;
  readonly notice?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="w-full">
      <AppSectionHeader>
        <AppSectionTitle>Settings</AppSectionTitle>
      </AppSectionHeader>
      <div className="max-w-3xl space-y-6 p-7 max-[740px]:p-4">
        <section aria-label="App name" className="overflow-hidden rounded-lg border">
          <div className="flex flex-wrap items-center justify-between gap-5 p-5">
            <div className="min-w-0 flex-1 basis-48">
              <h3 className="text-sm font-medium">App name</h3>
              <p className="mt-2 break-words text-sm text-muted-foreground">{app.name}</p>
            </div>
            {renameAction}
          </div>
          {notice && (
            <div className="border-t bg-muted/15 px-5 py-3 text-xs leading-5 text-muted-foreground">
              {notice}
            </div>
          )}
        </section>
        {app.copiedFrom && (
          <section aria-label="Copied from" className="rounded-lg border p-5">
            <h3 className="text-sm font-medium">Copied from</h3>
            <p className="mt-2 break-words text-sm" title={app.copiedFrom.reference}>
              {app.copiedFrom.name}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Source <code title={app.copiedFrom.commit}>{app.copiedFrom.commit.slice(0, 7)}</code>
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              This app is an independent copy. Changes to the original do not update it.
            </p>
          </section>
        )}
        {children}
        {deleteAction && (
          <section aria-label="Delete app" className="rounded-lg border border-destructive/30 p-5">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div className="min-w-0 flex-1 basis-64">
                <h3 className="text-sm font-medium">Delete app</h3>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  Remove this app and its saved data. Connected accounts and other copies are kept.
                </p>
              </div>
              <div className="max-w-full">{deleteAction}</div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
