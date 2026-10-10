import { AppId, type Cursor, type DeploymentId, type Tool } from "@executor-js/sdk";
import type { OrganizationId } from "@executor-js/hosted-server/organization";
import { HostedClient } from "./api.ts";
import { hydratedResult, requestKey } from "@executor-js/ui/contracts/http";
import { BrowserAtoms } from "./telemetry.ts";
import { Effect, Schema } from "effect";
import { Atom } from "effect/reactivity";
import type { ResourceOrigins } from "@executor-js/mcp-auth/grants";
import { DeviceDecision, DeviceRequestView } from "@executor-js/mcp-auth/device";
import { authCallOptions, mcpAuthorization, type AuthCallOptions } from "./auth.ts";

/**
 * Where this deployment serves its MCP and API resources, canonical first, sent with each
 * server-rendered document. They can differ from the page's own origin, which serves the
 * dashboard and sign-in.
 */
export const resourceOriginsAtom = Atom.make<ResourceOrigins | null>(null).pipe(
  Atom.serializable({
    key: "hosted:resource-origins",
    schema: Schema.NullOr(
      Schema.Struct({
        mcp: Schema.NonEmptyArray(Schema.String),
        api: Schema.NonEmptyArray(Schema.String),
      }),
    ),
  }),
  Atom.keepAlive,
);

/** Safe OAuth setup errors shown to the person granting access. */
export class McpConnectionFailed extends Schema.TaggedError<McpConnectionFailed>()(
  "McpConnectionFailed",
  { message: Schema.String },
) {}
const request = <A>(
  operation: string,
  run: (
    options: AuthCallOptions,
  ) => Promise<{ data: A; error: null } | { data: null; error: { status: number } }>,
) =>
  Effect.flatMap(authCallOptions, (options) =>
    Effect.tryPromise({
      try: () => run(options),
      catch: () => new McpConnectionFailed({ message: "Cannot reach Executor. Try again." }),
    }),
  ).pipe(
    Effect.flatMap((result) =>
      result.error === null && result.data !== null
        ? Effect.succeed(result.data)
        : Effect.fail(
            new McpConnectionFailed({
              message:
                result.error?.status === 403
                  ? "You no longer have access to this organization. Choose another one."
                  : "This connection request could not be completed. Start again from your MCP client.",
            }),
          ),
    ),
    Effect.withSpan(`ui.mcp.${operation}`),
  );

/** The registered client metadata consent shows; Better Auth's public client response decodes to it. */
const McpClient = Schema.Struct({ client_name: Schema.optional(Schema.String) });

/** Look up registered client metadata; names from the authorization URL are not trusted. */
export const mcpClientAtom = Atom.family((clientId: string) =>
  BrowserAtoms.atom(
    request("client", (options) => mcpAuthorization(options).client(clientId)).pipe(
      Effect.flatMap((client) =>
        Schema.decodeUnknownEffect(McpClient)(client).pipe(
          Effect.mapError(
            () =>
              new McpConnectionFailed({
                message:
                  "This connection request could not be completed. Start again from your MCP client.",
              }),
          ),
        ),
      ),
    ),
  ).pipe(
    hydratedResult({
      key: `hosted:mcp-client:${requestKey({ clientId })}`,
      success: McpClient,
      error: McpConnectionFailed,
    }),
  ),
);

/** The chosen organization belongs to this consent POST, not a shared browser preference. */
export const mcpConsentAtom = BrowserAtoms.fn(
  (input: { accept: boolean; organization: string | undefined; query: string }) =>
    request("consent", (options) => mcpAuthorization(options).consent(input)),
);

/**
 * Device sign-in requests fail for reasons the person can act on: a mistyped or expired code, a
 * code already used, or an organization they no longer belong to.
 */
const deviceCall = <A>(
  operation: string,
  run: (
    options: AuthCallOptions,
  ) => Promise<{ data: unknown; error: null } | { data: null; error: { status: number } }>,
  schema: Schema.Decoder<A>,
) =>
  Effect.flatMap(authCallOptions, (options) =>
    Effect.tryPromise({
      try: () => run(options),
      catch: () => new McpConnectionFailed({ message: "Cannot reach Executor. Try again." }),
    }),
  ).pipe(
    Effect.flatMap((result) =>
      result.error === null
        ? Schema.decodeUnknownEffect(schema)(result.data).pipe(
            Effect.mapError(
              () => new McpConnectionFailed({ message: "Something went wrong. Try again." }),
            ),
          )
        : Effect.fail(
            new McpConnectionFailed({
              message:
                result.error.status === 404
                  ? "This code is not valid or has expired. Check the code your device shows, or start signing in again there."
                  : result.error.status === 409
                    ? "This code was already used. Start signing in again on your device."
                    : result.error.status === 403
                      ? "You no longer have access to this organization. Choose another one."
                      : result.error.status === 429
                        ? "Too many attempts. Wait a minute and try again."
                        : "This request could not be completed. Try again.",
            }),
          ),
    ),
    Effect.withSpan(`ui.device.${operation}`),
  );

/** The pending device sign-in a user code names, for the person deciding it. */
export const deviceRequestAtom = Atom.family((userCode: string) =>
  BrowserAtoms.atom(
    deviceCall(
      "request",
      (options) => mcpAuthorization(options).deviceRequest(userCode),
      DeviceRequestView,
    ),
  ).pipe(
    hydratedResult({
      key: `hosted:device-request:${requestKey({ userCode })}`,
      success: DeviceRequestView,
      error: McpConnectionFailed,
    }),
  ),
);

/** The organization chosen on the page belongs to this decision only. */
export const deviceDecisionAtom = BrowserAtoms.fn(
  (input: { userCode: string; accept: boolean; organization: string | undefined }) =>
    deviceCall(
      "decide",
      (options) => mcpAuthorization(options).decideDevice(input),
      DeviceDecision,
    ),
);

/** Consent searches the complete live catalog, including tools beyond the first page. */
export const mcpToolsAtoms = Atom.family((organization: OrganizationId) =>
  Atom.family((app: AppId) =>
    HostedClient.runtime.atom(
      Effect.gen(function* () {
        const client = yield* HostedClient;
        const tools: Tool[] = [];
        const cursors = new Set<Cursor>();
        let cursor: Cursor | undefined;
        let deployment: DeploymentId | undefined;
        do {
          const page = yield* client.tools.list({
            params: { organization, app },
            query: { cursor },
          });
          if (deployment !== undefined && deployment !== page.deployment)
            return yield* new McpConnectionFailed({
              message: "This app changed while its tools were loading. Try again.",
            });
          deployment = page.deployment;
          tools.push(...page.items);
          cursor = page.next;
          if (cursor !== undefined) {
            if (cursors.has(cursor))
              return yield* new McpConnectionFailed({
                message: "This app's tool list could not be loaded. Try again.",
              });
            cursors.add(cursor);
          }
        } while (cursor !== undefined);
        return tools;
      }),
    ),
  ),
);
