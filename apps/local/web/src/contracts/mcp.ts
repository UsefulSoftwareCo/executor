import { DashboardClient } from "./api.ts";

/** OAuth endpoint and management app IDs; this response contains no administrative credential. */
export const mcpInstallationAtom = DashboardClient.query("dashboard", "mcpInstallation", {});

import { Effect, Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { BrowserAtoms } from "./telemetry.ts";

/** Connection errors contain only safe product text, never OAuth callback data. */
export class McpConnectionFailed extends Schema.TaggedError<McpConnectionFailed>()(
  "McpConnectionFailed",
  { message: Schema.String },
) {}
const json = <A>(path: string, schema: Schema.Decoder<A>, init?: RequestInit) =>
  Effect.tryPromise({
    try: () => fetch(path, { ...init, credentials: "same-origin" }),
    catch: () =>
      new McpConnectionFailed({
        message: "Cannot reach Executor. Check that the local server is running.",
      }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({
            try: () => response.json(),
            catch: () =>
              new McpConnectionFailed({ message: "The connection response could not be read." }),
          })
        : Effect.fail(
            new McpConnectionFailed({
              message: "This connection could not be completed. Start again from your MCP client.",
            }),
          ),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(
      () =>
        new McpConnectionFailed({
          message: "This connection could not be completed. Start again from your MCP client.",
        }),
    ),
  );
/** Registered client metadata is loaded from the issuer, never trusted from a URL label. */
export const localMcpClientAtom = Atom.family((id: string) =>
  BrowserAtoms.atom(
    json(
      `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(id)}`,
      Schema.Struct({ client_name: Schema.optionalKey(Schema.String) }),
    ),
  ),
);
/** Pairing cookies authorize the selected grant; no MCP bearer key is sent from this page. */
export const localMcpConsentAtom = BrowserAtoms.fn((input: { accept: boolean; query: string }) =>
  json("/api/auth/oauth2/consent", Schema.Struct({ url: Schema.NonEmptyString }), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ accept: input.accept, oauth_query: input.query }),
  }),
);
