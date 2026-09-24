import { sourceDisplay, sourceDisplayFile } from "./implementation/source-display.ts";
import {
  AppAccessDenied,
  AppIdentity,
  appManagementApi,
  type AppCapabilities,
} from "./contracts/api.ts";
export * from "./contracts/api.ts";
/** Product-authorized app authoring, release discovery, and ordinary Git access. */
import { Context, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
} from "effect/unstable/httpapi";
import { AppGitProtocol } from "./contracts/git.ts";
import {
  AppId,
  AppSlug,
  AppNotFound,
  SourceCommit,
  SourceError,
  StorageError,
  type App,
  type AppSourceStorage,
  type BlobStorage,
  type Executor,
} from "@executor-js/sdk/core";
import {
  RegistryError,
  Publication,
  PublicationSnapshot,
  PackageName,
  resolvePublication,
  type Registry,
  type createAppRegistry,
} from "@executor-js/app-registry";
import { type RepositoryBackend } from "@executor-js/app-source/contracts";

/** Hosts retain platform resources; these operations run inside each request's scope. */
export class AppManagementHost extends Context.Service<
  AppManagementHost,
  Effect.Effect<
    {
      readonly executor: Executor;
      /** Optional product-owned policy; local pairing uses the identity's existing authority. */
      readonly access?:
        | ((
            app: App,
            identity: Context.Service.Shape<typeof AppIdentity>,
          ) => Effect.Effect<AppCapabilities, AppAccessDenied | StorageError>)
        | undefined;
      readonly sources: AppSourceStorage;
      readonly repositories: RepositoryBackend;
      readonly registry: Registry;
      readonly blobs: BlobStorage;
      readonly publisher: ReturnType<typeof createAppRegistry> | undefined;
    },
    StorageError
  >
>()("apps/ManagementHost") {}
/** Cookies never authorize Git. The host validates the explicit scoped Git credential. */
export class AppGitAccess extends Context.Service<
  AppGitAccess,
  {
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
      scope: string,
    ) => Effect.Effect<Context.Service.Shape<typeof AppIdentity>, AppAccessDenied>;
  }
>()("apps/GitAccess") {}

const writeIdentity = AppIdentity.pipe(
  Effect.flatMap((identity) =>
    identity.canWrite
      ? Effect.succeed(identity)
      : Effect.fail(new AppAccessDenied({ reason: "forbidden" })),
  ),
);
type ManagementHost = Effect.Success<Context.Service.Shape<typeof AppManagementHost>>;
const capabilities = (
  host: ManagementHost,
  app: App,
  identity: Context.Service.Shape<typeof AppIdentity>,
) =>
  host.access === undefined
    ? Effect.succeed({ visible: true, manage: true, edit: true })
    : host.access(app, identity);
const projectApp = <A extends App>(
  host: ManagementHost,
  app: A,
  identity: Context.Service.Shape<typeof AppIdentity>,
) => capabilities(host, app, identity).pipe(Effect.as(app));
const ownedSource = (
  host: ManagementHost,
  identity: Context.Service.Shape<typeof AppIdentity>,
  id: AppId,
  edit = false,
) =>
  Effect.gen(function* () {
    if (identity.appIds !== undefined && !identity.appIds.includes(id))
      return yield* new AppAccessDenied({ reason: "forbidden" });
    const app = yield* host.executor.apps.get(
      identity.readOwner === null ? { app: id } : { owner: identity.readOwner, app: id },
    );
    const access = yield* capabilities(host, app, identity);
    if (!access.manage || (edit && !access.edit))
      return yield* new AppAccessDenied({ reason: "forbidden" });
    return { app, access };
  });
const editIdentity = (app: AppId) =>
  writeIdentity.pipe(
    Effect.flatMap((identity) =>
      identity.protectedApps.includes(app)
        ? Effect.fail(new AppAccessDenied({ reason: "forbidden" }))
        : Effect.succeed(identity),
    ),
  );
const authoring = (id: AppId) =>
  Effect.gen(function* () {
    const identity = yield* AppIdentity;
    const host = yield* Effect.flatten(AppManagementHost);
    const { app, access } = yield* ownedSource(host, identity, id);
    const canEdit = identity.canWrite && access.edit && !identity.protectedApps.includes(id);
    return {
      app,
      host,
      metadata: {
        namespace: identity.namespace,
        gitPath: `/git/${encodeURIComponent(identity.scope)}/${app.slug}.git`,
        canEdit,
        canPublish: canEdit && host.publisher !== undefined && identity.namespace !== null,
      },
    };
  });
/** Publication preview always checks the complete stored files, never a display listing. */
const workspaceSource = (id: AppId) =>
  Effect.gen(function* () {
    const { app, host, metadata } = yield* authoring(id);
    const source = yield* host.executor.apps.workspace({ owner: app.owner, app: id });
    const { canPublish, ...fields } = metadata;
    return {
      ...source,
      ...fields,
      publication:
        canPublish && host.publisher !== undefined && metadata.namespace !== null
          ? yield* host.publisher.preview({
              owner: app.owner,
              namespace: metadata.namespace,
              app: app.id,
              name: app.name,
              files: source.files,
            })
          : null,
    };
  });
/** Routes call existing SDK app operations; authoring never creates another project identity. */
export const appManagementHandlers = <I extends HttpApiMiddleware.AnyId, S, Id extends string>(
  api: ReturnType<typeof appManagementApi<I, S>>,
  apiId: Id,
) =>
  HttpApiBuilder.group(HttpApi.make(apiId).addHttpApi(api), "appManagement", (h) =>
    h
      .handle("list", () =>
        Effect.gen(function* () {
          const identity = yield* AppIdentity;
          const host = yield* Effect.flatten(AppManagementHost);
          const apps = yield* host.executor.apps.list({
            ...(identity.readOwner === null ? {} : { owner: identity.readOwner }),
            ids: identity.appIds,
          });
          return (yield* Effect.forEach(apps, (app) =>
            capabilities(host, app, identity).pipe(
              Effect.map((access) => (access.visible ? [app] : [])),
            ),
          )).flat();
        }),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const identity = yield* writeIdentity;
          const host = yield* Effect.flatten(AppManagementHost);
          return yield* host.executor.apps
            .create({ ...payload, owner: identity.owner })
            .pipe(Effect.flatMap((app) => projectApp(host, app, identity)));
        }),
      )
      .handle("authoring", ({ params }) =>
        authoring(params.app).pipe(Effect.map(({ metadata }) => metadata)),
      )
      .handle("source", ({ params }) => workspaceSource(params.app))
      .handle("sourceDisplay", ({ params }) =>
        workspaceSource(params.app).pipe(Effect.flatMap(sourceDisplay)),
      )
      .handle("sourceDisplayFile", ({ params, query }) =>
        Effect.gen(function* () {
          const { app, host } = yield* authoring(params.app);
          // The commit pins the listed revision; the app's own code lineage pins its repository.
          const files = yield* host.sources.read({ code: app.code, commit: params.commit });
          return yield* sourceDisplayFile(files, query.path);
        }),
      )
      .handle("commit", ({ params, payload }) =>
        Effect.gen(function* () {
          const identity = yield* editIdentity(params.app);
          const host = yield* Effect.flatten(AppManagementHost);
          const { app } = yield* ownedSource(host, identity, params.app, true);
          return yield* host.executor.apps.commit({
            ...payload,
            owner: app.owner,
            app: params.app,
          });
        }),
      )
      .handle("deploy", ({ params, payload }) =>
        Effect.gen(function* () {
          const identity = yield* editIdentity(params.app);
          const host = yield* Effect.flatten(AppManagementHost);
          const { app } = yield* ownedSource(host, identity, params.app, true);
          const deployed = yield* host.executor.apps.deploy({
            owner: app.owner,
            app: app.id,
            ...payload,
          });
          return {
            app: yield* projectApp(host, deployed.app, identity),
            deployment: deployed.deployment,
          };
        }),
      )
      .handle("copy", ({ payload }) =>
        Effect.gen(function* () {
          const identity = yield* writeIdentity;
          const host = yield* Effect.flatten(AppManagementHost);
          const from =
            "app" in payload.from
              ? (yield* ownedSource(host, identity, payload.from.app)).app.id
              : yield* resolvePublication(host.registry, payload.from);
          return yield* host.executor.apps
            .copy({
              owner: identity.owner,
              from,
              name: payload.name,
            })
            .pipe(Effect.flatMap((app) => projectApp(host, app, identity)));
        }),
      )
      .handle("git", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* AppIdentity;
          const host = yield* Effect.flatten(AppManagementHost);
          const { app } = yield* ownedSource(host, identity, params.app);
          return { path: `/git/${encodeURIComponent(identity.scope)}/${app.slug}.git` };
        }),
      )
      .handle("history", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* AppIdentity;
          const host = yield* Effect.flatten(AppManagementHost);
          const { app } = yield* ownedSource(host, identity, params.app);
          if (app.repository === null)
            yield* host.executor.apps.workspace({ app: app.id, owner: app.owner });
          return yield* host.repositories.history(app.code);
        }),
      )
      .handle("publish", ({ params, payload }) =>
        Effect.gen(function* () {
          const identity = yield* editIdentity(params.app);
          const host = yield* Effect.flatten(AppManagementHost);
          yield* ownedSource(host, identity, params.app, true);
          if (host.publisher === undefined || identity.namespace === null)
            return yield* new AppAccessDenied({ reason: "forbidden" });
          return yield* host.publisher.publish({
            owner: identity.owner,
            namespace: identity.namespace,
            app: params.app,
            ...payload,
          });
        }),
      )
      .handle("catalog", ({ query }) =>
        Effect.gen(function* () {
          return yield* (yield* Effect.flatten(AppManagementHost)).registry.list(query.name);
        }),
      )
      .handle("published", () =>
        Effect.gen(function* () {
          const identity = yield* AppIdentity;
          const host = yield* Effect.flatten(AppManagementHost);
          return host.publisher === undefined ? [] : yield* host.publisher.owned(identity.owner);
        }),
      )
      .handle("unpublish", ({ payload }) =>
        Effect.gen(function* () {
          const identity = yield* writeIdentity;
          const host = yield* Effect.flatten(AppManagementHost);
          if (host.publisher === undefined)
            return yield* new AppAccessDenied({ reason: "forbidden" });
          yield* host.publisher.unpublish(identity.owner, payload.package);
          return { name: payload.package };
        }),
      ),
  );
/** Mount the same browser/CLI operations under a product's authorized API prefix. */
export const appManagementRoutes = <I extends HttpApiMiddleware.AnyId, S>(
  api: ReturnType<typeof appManagementApi<I, S>>,
) => {
  return HttpApiBuilder.layer(api).pipe(Layer.provide(appManagementHandlers(api, api.identifier)));
};

/** Public registry reads expose selected release source, never private app Git history. */
export const registryRoutes = (() => {
  const api = HttpApi.make("app-registry").add(
    HttpApiGroup.make("registry").add(
      HttpApiEndpoint.get("list", "/api/registry/apps", {
        query: { name: Schema.optional(PackageName) },
        success: Schema.Array(Publication),
        error: RegistryError,
      }),
      HttpApiEndpoint.get("snapshot", "/api/registry/source", {
        query: { name: PackageName, commit: SourceCommit },
        success: PublicationSnapshot,
        error: RegistryError,
      }),
    ),
  );
  const publicRegistry = Effect.flatten(AppManagementHost).pipe(
    Effect.mapError(() => new RegistryError({ reason: "storage" })),
  );
  return HttpApiBuilder.layer(api).pipe(
    Layer.provide(
      HttpApiBuilder.group(api, "registry", (h) =>
        h
          .handle("list", ({ query }) =>
            Effect.flatMap(publicRegistry, (host) => host.registry.list(query.name)),
          )
          .handle("snapshot", ({ query }) =>
            Effect.flatMap(publicRegistry, (host) =>
              host.registry.snapshot(query.name, query.commit),
            ),
          ),
      ),
    ),
  );
})();

/** Resolve readable app slugs inside the authenticated owner's inventory before opening Git source. */
export const gitRoutes = (() => {
  const api = HttpApi.make("app-git").add(AppGitProtocol.prefix("/git"));
  const handle = Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scope = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(params.owner);
    const identity = yield* (yield* AppGitAccess).authenticate(request, scope);
    const slug = yield* Schema.decodeUnknownEffect(AppSlug)(
      params.repo?.replace(/\.git$/, ""),
    ).pipe(Effect.mapError(() => new AppAccessDenied({ reason: "forbidden" })));
    const host = yield* Effect.flatten(AppManagementHost);
    const matches = (yield* host.executor.apps.list({
      ...(identity.readOwner === null ? {} : { owner: identity.readOwner }),
      ids: identity.appIds,
    })).filter((app) => app.slug === slug);
    const match = matches[0];
    // Local root access spans owner partitions. Never choose an arbitrary same-named app.
    if (matches.length !== 1 || match === undefined)
      return yield* new AppAccessDenied({ reason: "forbidden" });
    const { app, access } = yield* ownedSource(host, identity, match.id);
    if (app.slug !== slug) return yield* new AppAccessDenied({ reason: "forbidden" });
    const url = new URL(request.url, "http://executor.invalid");
    const write =
      url.pathname.endsWith("/git-receive-pack") ||
      url.searchParams.get("service") === "git-receive-pack";
    if (write && (!identity.canWrite || !access.edit || identity.protectedApps.includes(app.id)))
      return yield* new AppAccessDenied({ reason: "forbidden" });
    if (app.repository === null)
      yield* host.executor.apps.workspace({ app: app.id, owner: app.owner });
    return HttpServerResponse.fromWeb(
      yield* host.repositories.request(app.code, yield* HttpServerRequest.toWeb(request)),
    ).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.empty({
          status:
            Schema.is(AppAccessDenied)(error) || Schema.is(AppNotFound)(error)
              ? 401
              : Schema.is(SourceError)(error) && error.reason === "protected"
                ? 403
                : 503,
          headers: {
            "www-authenticate": 'Basic realm="Executor Git"',
            "cache-control": "no-store",
          },
        }),
      ),
    ),
  );
  return HttpApiBuilder.layer(api).pipe(
    Layer.provide(
      HttpApiBuilder.group(api, "protocol", (h) =>
        h
          .handleRaw("infoRefs", () => handle)
          .handleRaw("uploadPack", () => handle)
          .handleRaw("receivePack", () => handle),
      ),
    ),
  );
})();
