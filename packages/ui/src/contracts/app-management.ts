/** Typed app bindings share reconciliation; products supply their existing client and runtime. */
import type { App, AppId } from "@executor-js/sdk";
import { AppAccess, appManagementApi, type CopyApp } from "@executor-js/app-management/contracts";
import { Array as Arr, Data, Effect, type Cause } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { Atom } from "effect/unstable/reactivity";
import { acknowledge, acknowledgedQuery } from "./mutations.ts";

class OwnedCopy extends Data.Class<{ readonly app: AppId }> {}
class PublicCopy extends Data.Class<{ readonly package: string; readonly commit: string }> {}
class SourceFileKey extends Data.Class<{
  readonly app: AppId;
  readonly commit: string;
  readonly path: string;
}> {}

const api = appManagementApi("/api", AppAccess);
type WireClient = HttpApiClient.ForApi<typeof api>["appManagement"];
type Endpoints = typeof api.groups.appManagement.endpoints;
type WithoutResponseMode<Request> = Request extends unknown ? Omit<Request, "responseMode"> : never;
type Client<E> = {
  readonly [K in keyof WireClient]: (
    request: WithoutResponseMode<Parameters<WireClient[K]>[0]>,
  ) => Effect.Effect<Endpoints[K]["~Success"]["Type"], E>;
};
/** Each host patches confirmed app metadata using its existing mutation conventions. */
export type AppAcknowledgement = (get: Atom.FnContext, app: App) => void;
/** Product client errors remain typed; the shared builder owns no transport or authentication. */
export const makeAppManagementAtoms = <R, E>(
  runtime: Atom.AtomRuntime<R>,
  client: Effect.Effect<Client<E>, never, R>,
  params: { readonly organization?: string },
  retainFailure?: (cause: Cause.Cause<E>) => boolean,
) => {
  const catalog = runtime
    .atom(Effect.flatMap(client, (api) => api.catalog({ params, query: {} })))
    .pipe(Atom.refreshOnWindowFocus, (source) => acknowledgedQuery(source, retainFailure));
  const published = runtime
    .atom(Effect.flatMap(client, (api) => api.published({ params })))
    .pipe((source) => acknowledgedQuery(source, retainFailure));
  const authoring = Atom.family((app: AppId) =>
    runtime
      .atom(Effect.flatMap(client, (api) => api.authoring({ params: { ...params, app } })))
      .pipe(Atom.refreshOnWindowFocus, (source) => acknowledgedQuery(source, retainFailure)),
  );
  const source = Atom.family((app: AppId) =>
    runtime
      .atom(Effect.flatMap(client, (api) => api.sourceDisplay({ params: { ...params, app } })))
      .pipe(Atom.refreshOnWindowFocus, (source) => acknowledgedQuery(source, retainFailure)),
  );
  // A commit is immutable, so a loaded file never needs a refresh.
  const sourceFiles = Atom.family((key: SourceFileKey) =>
    runtime
      .atom(
        Effect.flatMap(client, (api) =>
          api.sourceDisplayFile({
            params: { ...params, app: key.app, commit: key.commit },
            query: { path: key.path },
          }),
        ),
      )
      .pipe(Atom.setIdleTTL("5 minutes")),
  );
  const history = Atom.family((app: AppId) =>
    runtime
      .atom(Effect.flatMap(client, (api) => api.history({ params: { ...params, app } })))
      .pipe(Atom.refreshOnWindowFocus),
  );
  /** Exact working bytes for an editor. Unmounted editors release it, so each edit reads afresh. */
  const workspace = Atom.family((app: AppId) =>
    runtime
      .atom(Effect.flatMap(client, (api) => api.source({ params: { ...params, app } })))
      .pipe((source) => acknowledgedQuery(source, retainFailure)),
  );
  /**
   * Commit one text file on top of the current working source; a null base creates a new file. Like a Git host's web
   * editor. A commit never deploys. Other files may have changed since the editor opened; the file itself must not have.
   * The server's `expected` check still rejects a commit that lands between this read and write.
   */
  const commitFile = Atom.family((app: AppId) =>
    runtime.fn(
      (
        input: {
          path: string;
          base: string | null;
          content: string;
          message: string;
        },
        get,
      ) =>
        Effect.gen(function* () {
          const api = yield* client;
          const current = yield* api.source({ params: { ...params, app } });
          const file = current.files.find((item) => item.path === input.path);
          if ((file === undefined ? null : file.content) !== input.base) {
            // Let the editor offer the newer version when the person discards their draft.
            get.refresh(workspace(app));
            return { _tag: "FileChanged" as const };
          }
          const files =
            file === undefined
              ? Arr.append(current.files, { path: input.path, content: input.content })
              : Arr.map(current.files, (item) =>
                  item.path === input.path ? { path: item.path, content: input.content } : item,
                );
          const saved = yield* api.commit({
            params: { ...params, app },
            payload: { expected: current.revision.commit, files, message: input.message },
          });
          acknowledge(get, workspace(app), (previous) => ({ ...previous, ...saved }));
          get.refresh(source(app));
          get.refresh(history(app));
          return { _tag: "Committed" as const, commit: saved.revision.commit };
        }),
    ),
  );
  const deploy = Atom.family((app: AppId) =>
    runtime.fn(
      (
        input: {
          commit: string;
          onApp: AppAcknowledgement;
        },
        get,
      ) =>
        Effect.flatMap(client, (api) =>
          api.deploy({
            params: { ...params, app },
            payload: {
              commit: input.commit,
            },
          }),
        ).pipe(
          Effect.tap((saved) =>
            Effect.sync(() => {
              input.onApp(get, saved.app);
            }),
          ),
        ),
    ),
  );
  const copies = Atom.family((from: typeof CopyApp.Type.from) =>
    runtime.fn((input: { name: string; onApp: AppAcknowledgement }, get) =>
      Effect.flatMap(client, (api) =>
        api.copy({ params, payload: { from, name: input.name } }),
      ).pipe(Effect.tap((saved) => Effect.sync(() => input.onApp(get, saved)))),
    ),
  );
  const publish = Atom.family((app: AppId) =>
    runtime.fn((commit: string, get) =>
      Effect.flatMap(client, (api) =>
        api.publish({ params: { ...params, app }, payload: { commit } }),
      ).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            for (const query of [published, catalog])
              acknowledge(get, query, (rows) => [
                ...rows.filter((row) => row.name !== saved.name),
                saved,
              ]);
          }),
        ),
      ),
    ),
  );
  const unpublish = Atom.family((name: string) =>
    runtime.fn((_: void, get) =>
      Effect.flatMap(client, (api) => api.unpublish({ params, payload: { package: name } })).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            for (const query of [published, catalog])
              acknowledge(get, query, (rows) => rows.filter((row) => row.name !== saved.name));
          }),
        ),
      ),
    ),
  );
  return {
    catalog,
    published,
    authoring,
    source,
    /** One display file of a listed revision, for files the listing does not inline. */
    sourceFile: (key: ConstructorParameters<typeof SourceFileKey>[0]) =>
      sourceFiles(new SourceFileKey(key)),
    history,
    workspace,
    commitFile,
    deploy,
    copy: (from: typeof CopyApp.Type.from) =>
      copies("app" in from ? new OwnedCopy(from) : new PublicCopy(from)),
    publish,
    unpublish,
  };
};
export type AppManagementAtoms<E> = ReturnType<typeof makeAppManagementAtoms<never, E>>;

/** Shared views keep the host's exact error renderer beside its typed atoms. */
export interface AppManagementProps<E> {
  readonly atoms: AppManagementAtoms<E>;
  readonly Failure: import("react").ComponentType<
    import("./dashboard.ts").FailureProps<NoInfer<E>>
  >;
}
