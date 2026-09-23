import { AppId, type Cursor, type DeploymentId, type Tool } from "@executor-js/sdk";
import type { OrganizationId } from "@executor-js/hosted-server/organization";
import { HostedClient } from "./api.ts";
import { traceHeaders } from "@executor-js/telemetry";
import { BrowserAtoms } from "./telemetry.ts";
import { Effect, Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { mcpAuthorization } from "./auth.ts";

/** Safe OAuth setup errors shown to the person granting access. */
export class McpConnectionFailed extends Schema.TaggedError<McpConnectionFailed>()(
  "McpConnectionFailed",
  { message: Schema.String },
) {}
const request = <A>(
  operation: string,
  run: (options: {
    headers: Readonly<Record<string, string>>;
  }) => Promise<{ data: A; error: null } | { data: null; error: { status: number } }>,
) =>
  Effect.flatMap(traceHeaders, (headers) =>
    Effect.tryPromise({
      try: () => run({ headers }),
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

/** Look up registered client metadata; names from the authorization URL are not trusted. */
export const mcpClientAtom = Atom.family((clientId: string) =>
  BrowserAtoms.atom(request("client", (options) => mcpAuthorization(options).client(clientId))),
);

/** The chosen organization belongs to this consent POST, not a shared browser preference. */
export const mcpConsentAtom = BrowserAtoms.fn(
  (input: { accept: boolean; organization: string; query: string }) =>
    request("consent", (options) => mcpAuthorization(options).consent(input)),
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
