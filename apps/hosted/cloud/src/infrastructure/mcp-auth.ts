/** MCP grant checks for the API's MCP gateway and the MCP server's session objects. */
import {
  AuthenticationUnavailable,
  McpAuthentication,
  authOptions,
  type HostedOAuthOrigins,
  mcpBrowserGrantError,
  mcpBearerAccess,
  mcpConnectionStore,
} from "@executor-js/hosted-server";
import { BetterAuthApiError, isAPIErrorLike } from "@alchemy.run/better-auth";
import { RuntimeContext } from "alchemy";
import { betterAuth } from "better-auth";
import { Effect, Layer, Option, Redacted } from "effect";
import type { SqlClient } from "effect/sql";
import { cloudSessionCookiePrefix } from "../contracts/browser.ts";
import { organizationTables } from "./app-sessions.ts";
import { AuthDatabase, type AuthDatabaseService } from "./auth-database.ts";
import { invocationSql } from "./invocation-database.ts";
import { cloudSecrets } from "./secrets.ts";
import { cloudHosts } from "./stage.ts";

/**
 * Better Auth with the shared grant, API key and admin plugins and the organization columns the
 * grant checks read. The dashboard's instance adds sign-in, email and billing to the same
 * plugins and writes the same rows; none of its additions take part in a grant check.
 */
const mcpGrantAuth = (
  { origin, resourceOrigins, issuer }: HostedOAuthOrigins,
  database: AuthDatabaseService,
  secret: string,
) => {
  const base = authOptions(
    { url: origin, resourceOrigins, issuer, oauthRedirectUri: Option.none() },
    ["cf-connecting-ip"],
  );
  return betterAuth({
    ...base,
    plugins: [...base.plugins, organizationTables],
    database: database.options,
    secret,
    advanced: {
      ...base.advanced,
      cookiePrefix: cloudSessionCookiePrefix(origin),
      // As in the dashboard: the deployment migration validates the schema, not requests.
      database: { ...base.advanced.database, validateSchema: false },
      backgroundTasks: { handler: database.background },
    },
  });
};

/** The server-only grant endpoints; both instances register them through the shared plugins. */
type McpGrantApi = Pick<
  ReturnType<typeof mcpGrantAuth>["api"],
  | "getMcpBrowserAccess"
  | "getOAuthServerConfig"
  | "listMcpConnections"
  | "createMcpConnection"
  | "updateMcpConnection"
  | "revokeMcpConnection"
  | "listMcpAgents"
  | "revokeMcpAgent"
>;

/**
 * MCP authentication. Bearer checks read their rows in one statement through `withSql`; browser
 * grants, metadata and connections use the isolate's Better Auth instance, which `bound` pairs
 * with the calling invocation's pool. Every check uses the caller's connections.
 */
export const mcpAuthentication = (
  origins: HostedOAuthOrigins,
  bound: Effect.Effect<readonly [{ readonly api: McpGrantApi }, <A>(run: () => A) => A]>,
  withSql: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A, E>,
) =>
  Layer.effect(
    McpAuthentication,
    Effect.gen(function* () {
      return McpAuthentication.of({
        ...origins,
        authenticate: (headers, mode, organization) =>
          withSql(mcpBearerAccess(origins, { headers, mode, organization })).pipe(
            Effect.tap(({ access }) =>
              Effect.annotateCurrentSpan("executor.organization.id", access.organization),
            ),
            Effect.withSpan("auth.authenticate"),
          ),
        browserGrant: (headers, id) =>
          bound.pipe(
            Effect.flatMap(([instance, bind]) =>
              Effect.tryPromise({
                try: () => bind(() => instance.api.getMcpBrowserAccess({ headers, body: { id } })),
                catch: mcpBrowserGrantError,
              }),
            ),
          ),
        metadata: bound.pipe(
          Effect.flatMap(([instance, bind]) =>
            Effect.tryPromise({
              try: () => bind(() => instance.api.getOAuthServerConfig()),
              catch: (error) => error,
            }),
          ),
          Effect.catch((error) =>
            isAPIErrorLike(error)
              ? Effect.fail(BetterAuthApiError.fromAPIError(error))
              : Effect.die(error),
          ),
          Effect.mapError(() => new AuthenticationUnavailable()),
        ),
        connections: mcpConnectionStore((run) =>
          bound.pipe(
            Effect.flatMap(([instance, bind]) =>
              Effect.tryPromise({
                try: () => bind(() => run(instance.api)),
                catch: (cause) => cause,
              }),
            ),
          ),
        ),
      });
    }),
  );

/**
 * The MCP server Worker's identity. Bearer checks need no Better Auth instance; the one built for
 * browser grants and connections is per isolate, like the dashboard's, and holds no request state.
 */
export const cloudMcpIdentity = Effect.gen(function* () {
  const hosts = yield* cloudHosts.pipe(Effect.orDie);
  const origins = {
    origin: hosts.browser,
    resourceOrigins: hosts.resourceOrigins,
    issuer: hosts.issuer,
  };
  const secrets = yield* cloudSecrets.pipe(Effect.orDie);
  const database = yield* AuthDatabase;
  let instance: ReturnType<typeof mcpGrantAuth> | undefined;
  const native = secrets.authSecret.pipe(
    Effect.map((secret) => (instance ??= mcpGrantAuth(origins, database, Redacted.value(secret)))),
  );
  return mcpAuthentication(
    origins,
    Effect.all([native, database.bind]).pipe(Effect.provide(RuntimeContext.phantom)),
    yield* invocationSql,
  );
});
