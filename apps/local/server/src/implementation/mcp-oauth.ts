/** Local OAuth authenticates consent with dashboard pairing; no hosted identity is required. */
import { betterAuth } from "better-auth";
import { APIError, isAPIError } from "better-auth/api";
import { makeSignature } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { authEndpointTemplates, grantExpiry, grantOAuthPlugins } from "@executor-js/mcp-auth/oauth";
import {
  GrantId,
  mcpOAuthResources,
  requestedMcpAddress,
  mcpResource,
  mcpResourceMetadataUrl,
  singleResourceOrigin,
} from "@executor-js/mcp-auth";
import { makeAuthDatabase } from "@executor-js/mcp-auth/node-database";
import type { ConnectionId, ConnectionPolicy } from "@executor-js/mcp-auth/connections";
import { pgliteLayer } from "fumadb-effect/pglite";
import {
  Effect,
  Layer,
  FileSystem,
  Path,
  Redacted,
  Schema,
  Semaphore,
  Clock,
  Option,
} from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { routeTemplates } from "@executor-js/telemetry";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import type { ServerConfig } from "../contracts/config.ts";
import { localRequest, sessionCookie, type LocalAuth } from "./auth.ts";

/** Invalid credentials never fall back to browser cookies or administrative authority. */
export class LocalMcpUnauthorized extends Schema.TaggedError<LocalMcpUnauthorized>()(
  "LocalMcpUnauthorized",
  {},
) {}
/** Auth database failures stay distinct from invalid credentials. */
export const LocalMcpAuthUnavailable = UserFacingError.define({
  tag: "LocalMcpAuthUnavailable",
  status: 503,
  title: "MCP authorization unavailable",
  description:
    "Executor could not read or update its local MCP authorization storage, so it could not check MCP credentials.",
  recovery: {
    action:
      "Try again. If this continues, copy the fix prompt into your agent to check Executor’s authorization storage.",
    instructions:
      "Inspect the local Executor instance’s MCP authorization database and safe diagnostics. Restore storage access without deleting grants, resetting credentials, or weakening authorization.",
  },
  retryable: true,
});
/** Parsed LocalMcpAuthUnavailable failure. */
export type LocalMcpAuthUnavailable = typeof LocalMcpAuthUnavailable.Type;
const failure = (error: unknown) =>
  isAPIError(error) && [400, 401, 403].includes(error.statusCode)
    ? new LocalMcpUnauthorized()
    : new LocalMcpAuthUnavailable();

/** Own the provider, database, and internal session in the local server scope. */
export const makeLocalMcpOAuth = (config: ServerConfig, pairing: LocalAuth, crypto: Crypto) =>
  Effect.gen(function* () {
    const origin = config.browserOrigin ?? `http://127.0.0.1:${config.port}`;
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const directory = path.join(config.directory, "mcp-auth.pglite");
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* fs.chmod(directory, 0o700);
    const databaseContext = yield* Layer.build(pgliteLayer({ dataDir: directory }));
    const db = yield* makeAuthDatabase.pipe(Effect.provideContext(databaseContext));
    // Separate signing material from encryption use; no generated or fallback secret.
    const secret = yield* Effect.promise(async () => {
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`executor-local-oauth:${Redacted.value(config.encryptionKey)}`),
      );
      return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    });
    // Local serves its browser pages and its MCP resources on one origin.
    const oauth = grantOAuthPlugins({
      origin,
      resourceOrigins: singleResourceOrigin(origin),
      issuer: `${origin}/api/auth`,
      scopes: ["mcp", "offline_access"],
      resources: mcpOAuthResources([origin]),
      selectResource: (_ctx, _userId, required) =>
        required === undefined || required === "local"
          ? Effect.succeed("local")
          : Effect.fail(new APIError("FORBIDDEN")),
      checkResource: (_ctx, _userId, resource) =>
        resource === "local" ? Effect.void : Effect.fail(new APIError("FORBIDDEN")),
    });
    const options = {
      baseURL: origin,
      basePath: "/api/auth",
      secret,
      database: { db, type: "postgres" as const, transaction: true },
      trustedOrigins: [origin],
      plugins: [...oauth.plugins],
      session: { cookieCache: { enabled: false } },
      advanced: {
        cookiePrefix: "executor-local-oauth",
        ipAddress: { ipAddressHeaders: ["x-executor-client-ip"] },
      },
      rateLimit: { enabled: true, storage: "database" as const },
    };
    yield* Effect.tryPromise({
      try: async () => {
        const migration = await getMigrations(options);
        await migration.runMigrations();
      },
      catch: () => new LocalMcpAuthUnavailable(),
    });
    const auth = betterAuth(options);
    const context = yield* Effect.tryPromise({
      try: () => auth.$context,
      catch: () => new LocalMcpAuthUnavailable(),
    });
    yield* oauth
      .provisionResources(context)
      .pipe(Effect.mapError(() => new LocalMcpAuthUnavailable()));
    const user = yield* Effect.tryPromise({
      try: async () => {
        const found = await context.internalAdapter.findUserByEmail("operator@executor.local");
        return (
          found?.user ??
          (await context.internalAdapter.createUser(
            {
              name: "Local operator",
              email: "operator@executor.local",
              emailVerified: true,
            },
            { method: "admin" },
          ))
        );
      },
      catch: () => new LocalMcpAuthUnavailable(),
    });
    const makeSession = () =>
      Effect.tryPromise({
        try: () => context.internalAdapter.createSession(user.id),
        catch: () => new LocalMcpAuthUnavailable(),
      });
    let session = yield* makeSession();
    const semaphore = yield* Semaphore.make(1);
    const browserHeaders = (headers: Headers) =>
      Effect.gen(function* () {
        // Only the local dashboard cookie can establish this single operator identity.
        if (headers.has("authorization")) return yield* new LocalMcpUnauthorized();
        const cookies = headers.get("cookie") ?? "";
        const credential = cookies
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${sessionCookie(config)}=`))
          ?.slice(sessionCookie(config).length + 1);
        if (!(yield* pairing.valid(credential))) return yield* new LocalMcpUnauthorized();
        const cookie = yield* semaphore.withPermits(1)(
          Effect.gen(function* () {
            if (session.expiresAt.getTime() <= (yield* Clock.currentTimeMillis))
              session = yield* makeSession();
            const signature = yield* Effect.tryPromise({
              try: () => makeSignature(session.token, secret),
              catch: () => new LocalMcpAuthUnavailable(),
            });
            return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`;
          }),
        );
        const result = new Headers(headers);
        result.set("cookie", cookie);
        return result;
      });
    const authenticate = (headers: Headers) =>
      Effect.tryPromise({ try: () => auth.api.getMcpGrantAccess({ headers }), catch: failure });
    const browserGrant = (headers: Headers, id: GrantId) =>
      browserHeaders(headers).pipe(
        Effect.flatMap((headers) =>
          Effect.tryPromise({
            try: () => auth.api.getBrowserGrant({ headers, body: { id } }),
            catch: failure,
          }),
        ),
      );
    const routes = routeTemplates(authEndpointTemplates(auth.api));
    const handler = Effect.gen(function* () {
      const request = yield* localRequest(config.port, config.browserOrigin);
      const web = yield* HttpServerRequest.toWeb(request);
      const pathname = new URL(web.url).pathname;
      yield* routes.record(pathname);
      if (!pathname.startsWith("/api/auth/oauth2/") && !pathname.startsWith("/api/auth/mcp/grants"))
        return HttpServerResponse.empty({ status: 404 });
      const headers = new Headers(web.headers);
      headers.delete("x-executor-client-ip");
      if (Option.isSome(request.remoteAddress))
        headers.set("x-executor-client-ip", request.remoteAddress.value);
      headers.delete("cookie");
      if (
        request.headers.authorization === undefined &&
        (yield* pairing.valid(request.cookies[sessionCookie(config)]))
      ) {
        const verified = yield* browserHeaders(new Headers(web.headers));
        headers.set("cookie", verified.get("cookie") ?? "");
      }
      const response = yield* Effect.tryPromise({
        try: () => auth.handler(new Request(web, { headers })),
        catch: () => new LocalMcpAuthUnavailable(),
      });
      const outgoing = new Headers(response.headers);
      outgoing.delete("set-cookie");
      outgoing.set("cache-control", "no-store");
      return HttpServerResponse.fromWeb(
        new Response(response.body, { status: response.status, headers: outgoing }),
      );
    }).pipe(
      Effect.catchTags({
        AuthForbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
        LocalMcpUnauthorized: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
        LocalMcpAuthUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
        AuthStorageError: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      }),
    );
    const metadata = Effect.tryPromise({
      try: () => auth.api.getOAuthServerConfig(),
      catch: () => new LocalMcpAuthUnavailable(),
    }).pipe(Effect.map(HttpServerResponse.jsonUnsafe));
    const requestAddress = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
      requestedMcpAddress(new URL(request.url, origin)),
    );
    /** An MCP URL whose elicitation_mode or connection is repeated or unsupported. */
    const invalidAddress = HttpServerResponse.jsonUnsafe(
      { error: "Unsupported elicitation_mode or connection." },
      { status: 400 },
    );
    const protectedResource = requestAddress.pipe(
      Effect.map((address) =>
        address === undefined
          ? invalidAddress
          : HttpServerResponse.jsonUnsafe({
              resource: mcpResource(origin, address),
              authorization_servers: [`${origin}/api/auth`],
              scopes_supported: ["mcp", "offline_access"],
              bearer_methods_supported: ["header"],
              resource_name: "Executor Local",
            }),
      ),
    );
    const challenge = requestAddress.pipe(
      Effect.map((address) =>
        address === undefined
          ? invalidAddress
          : HttpServerResponse.empty({
              status: 401,
              headers: {
                "www-authenticate": `Bearer resource_metadata="${mcpResourceMetadataUrl(origin, address)}", scope="mcp offline_access"`,
                "cache-control": "no-store",
              },
            }),
      ),
    );
    /** The paired dashboard's single operator owns every local connection. */
    const connectionOwner = { userId: user.id, resource: "local" };
    const connectionCall = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => (isAPIError(cause) ? cause.statusCode : ("unavailable" as const)),
      });
    /** The grant's current authority, or none when it was revoked or deleted. */
    const grant = (id: GrantId) =>
      Effect.tryPromise({
        try: () => auth.api.getMcpGrant({ body: { id } }),
        // Only a definitive refusal means the grant is gone; an outage is retried.
        catch: (cause) =>
          isAPIError(cause) && [401, 403, 404].includes(cause.statusCode)
            ? ("refused" as const)
            : ("unavailable" as const),
      }).pipe(
        Effect.map(Option.some),
        Effect.catch((reason) =>
          reason === "refused"
            ? Effect.succeed(Option.none())
            : Effect.fail(new LocalMcpAuthUnavailable()),
        ),
      );
    const connections = {
      list: connectionCall(() => auth.api.listMcpConnections({ body: connectionOwner })),
      create: (input: { id: ConnectionId; name: string; policy: ConnectionPolicy }) =>
        connectionCall(() =>
          auth.api.createMcpConnection({ body: { ...connectionOwner, ...input } }),
        ),
      update: (input: { id: ConnectionId; name: string; policy: ConnectionPolicy }) =>
        connectionCall(() =>
          auth.api.updateMcpConnection({ body: { ...connectionOwner, ...input } }),
        ),
      revoke: (id: ConnectionId) =>
        connectionCall(() => auth.api.revokeMcpConnection({ body: { ...connectionOwner, id } })),
    };
    return {
      origin,
      authenticate,
      browserGrant,
      grant,
      handler,
      metadata,
      protectedResource,
      challenge,
      invalidAddress,
      connections,
      agentGrants: grantExpiry((run) =>
        Effect.tryPromise({ try: () => run(auth.api), catch: (cause) => cause }),
      ),
    };
  });
/** Provider capabilities captured by the local server, never by app code. */
export type LocalMcpOAuth = Effect.Success<ReturnType<typeof makeLocalMcpOAuth>>;
