import { sourceDisplay, sourceDisplayFile } from "./implementation/source-display.ts";
import {
  AppAccessDenied,
  AppIdentity,
  appManagementApi,
  type AppCapabilities,
} from "./contracts/api.ts";
export * from "./contracts/api.ts";
export {
  frameworkDocumentation,
  frameworkHandlers,
  frameworkRoutes,
} from "./implementation/framework.ts";
/** Product-authorized app authoring, release discovery, and ordinary Git access. */
import { Context, Effect, Layer, Schema } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
} from "effect/http-api";
import { AppGitProtocol } from "./contracts/git.ts";
import {
  AppId,
  AppSlug,
  AppSlugTaken,
  AppNotFound,
  RepositoryHost,
  SourceCommit,
  SourceError,
  StorageError,
  RegistryError,
  Publication,
  PublicationSnapshot,
  PackageName,
  type App,
  type Executor,
} from "@executor-js/sdk/core";

/** The executor and the product's authorization policy; every operation goes through the SDK. */
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
    },
    StorageError
  >
>()("apps/ManagementHost") {}
/**
 * The origins where the host serves {@link gitRoutes}, canonical first. Clone URLs use the
 * canonical one; the others keep earlier remotes working. A host that serves Git on the origin
 * it was called on reads that origin from the request.
 */
export class AppGitOrigins extends Context.Service<
  AppGitOrigins,
  (request: HttpServerRequest.HttpServerRequest) => readonly [string, ...string[]]
>()("apps/GitOrigins") {}
/** The clone URL of an app, on the host's canonical Git origin. */
const gitRemote = (scope: string, app: App) =>
  Effect.gen(function* () {
    const [origin] = (yield* AppGitOrigins)(yield* HttpServerRequest.HttpServerRequest);
    const path = `/git/${encodeURIComponent(scope)}/${app.slug}.git`;
    return { path, url: origin + path };
  });
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
    const { publishing } = yield* host.executor.publications
      .status()
      .pipe(Effect.mapError(() => new StorageError()));
    const remote = yield* gitRemote(identity.scope, app);
    return {
      app,
      host,
      metadata: {
        namespace: identity.namespace,
        gitPath: remote.path,
        gitUrl: remote.url,
        canEdit,
        canPublish: canEdit && publishing && identity.namespace !== null,
      },
    };
  });
/**
 * Name the app that holds a taken address, but only when the caller may see it. Hidden apps stay
 * anonymous; the address alone was already part of the request. The conflict remains the failure
 * when its holder cannot be read.
 */
const nameAddressHolder = (
  host: ManagementHost,
  identity: Context.Service.Shape<typeof AppIdentity>,
  error: AppSlugTaken,
) =>
  Effect.gen(function* () {
    const [holder] = yield* host.executor.apps.list({ owner: error.owner, slug: error.slug });
    if (
      holder === undefined ||
      (identity.appIds !== undefined && !identity.appIds.includes(holder.id))
    )
      return error;
    const access = yield* capabilities(host, holder, identity);
    return access.visible
      ? new AppSlugTaken({ ...error, existing: { app: holder.id, name: holder.name } })
      : error;
  }).pipe(
    Effect.orElseSucceed(() => error),
    Effect.flatMap(Effect.fail),
  );
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
        canPublish && metadata.namespace !== null
          ? yield* host.executor.publications.preview({
              owner: app.owner,
              namespace: metadata.namespace,
              app: app.id,
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
          return yield* host.executor.apps.create({ ...payload, owner: identity.owner }).pipe(
            Effect.catchTag("AppSlugTaken", (error) => nameAddressHolder(host, identity, error)),
            Effect.flatMap((app) => projectApp(host, app, identity)),
          );
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
          const files = yield* host.executor.apps.revision({
            owner: app.owner,
            app: app.id,
            commit: params.commit,
          });
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
              : payload.from;
          return yield* host.executor.apps
            .copy({
              owner: identity.owner,
              from,
              name: payload.name,
            })
            .pipe(
              Effect.catchTag("AppSlugTaken", (error) => nameAddressHolder(host, identity, error)),
              Effect.flatMap((app) => projectApp(host, app, identity)),
            );
        }),
      )
      .handle("git", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* AppIdentity;
          const host = yield* Effect.flatten(AppManagementHost);
          const { app } = yield* ownedSource(host, identity, params.app);
          return yield* gitRemote(identity.scope, app);
        }),
      )
      .handle("history", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* AppIdentity;
          const host = yield* Effect.flatten(AppManagementHost);
          const { app } = yield* ownedSource(host, identity, params.app);
          return yield* host.executor.apps.history({ owner: app.owner, app: app.id });
        }),
      )
      .handle("publish", ({ params, payload }) =>
        Effect.gen(function* () {
          const identity = yield* editIdentity(params.app);
          const host = yield* Effect.flatten(AppManagementHost);
          yield* ownedSource(host, identity, params.app, true);
          if (identity.namespace === null)
            return yield* new AppAccessDenied({ reason: "forbidden" });
          return yield* host.executor.publications
            .publish({
              owner: identity.owner,
              namespace: identity.namespace,
              app: params.app,
              ...payload,
            })
            .pipe(
              Effect.mapError((error) =>
                Schema.is(RegistryError)(error) && error.reason === "unsupported"
                  ? new AppAccessDenied({ reason: "forbidden" })
                  : error,
              ),
            );
        }),
      )
      .handle("catalog", ({ query }) =>
        Effect.gen(function* () {
          const host = yield* Effect.flatten(AppManagementHost);
          return yield* host.executor.registry.list(query);
        }),
      )
      .handle("published", () =>
        Effect.gen(function* () {
          const identity = yield* AppIdentity;
          const host = yield* Effect.flatten(AppManagementHost);
          return yield* host.executor.publications.owned({ owner: identity.owner });
        }),
      )
      .handle("unpublish", ({ payload }) =>
        Effect.gen(function* () {
          const identity = yield* writeIdentity;
          const host = yield* Effect.flatten(AppManagementHost);
          return yield* host.executor.publications
            .unpublish({ owner: identity.owner, package: payload.package })
            .pipe(
              Effect.mapError((error) =>
                Schema.is(RegistryError)(error) && error.reason === "unsupported"
                  ? new AppAccessDenied({ reason: "forbidden" })
                  : error,
              ),
            );
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
  // Public sites read the catalog from another origin (`executor.sh` reads `api.executor.sh`).
  // The reads carry no credentials, so any origin may read them; a preflight gets the same answer.
  const anyOrigin = HttpRouter.middleware(HttpMiddleware.cors({ allowedMethods: ["GET"] })).layer;
  return Layer.mergeAll(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(
        HttpApiBuilder.group(api, "registry", (h) =>
          h
            .handle("list", ({ query }) =>
              Effect.flatMap(publicRegistry, (host) => host.executor.registry.list(query)),
            )
            .handle("snapshot", ({ query }) =>
              Effect.flatMap(publicRegistry, (host) => host.executor.registry.snapshot(query)),
            ),
        ),
      ),
    ),
    HttpRouter.add("OPTIONS", "/api/registry/*", HttpServerResponse.empty({ status: 204 })),
  ).pipe(Layer.provide(anyOrigin));
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
    return HttpServerResponse.fromWeb(
      yield* host.executor[RepositoryHost].request(
        { owner: app.owner, app: app.id },
        yield* HttpServerRequest.toWeb(request),
      ),
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
