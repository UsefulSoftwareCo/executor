import { dashboardHttpClient, hydrated } from "@executor-js/ui/contracts/http";
import { DashboardClient } from "./api.ts";

/** OAuth endpoint and management app IDs; this response contains no administrative credential. */
export const mcpInstallationAtom = DashboardClient.query(
  "dashboard",
  "mcpInstallation",
  hydrated({}),
);

import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Atom } from "effect/reactivity";
import { BrowserAtoms } from "./telemetry.ts";

/** Connection errors contain only safe product text, never OAuth callback data. */
export class McpConnectionFailed extends Schema.TaggedError<McpConnectionFailed>()(
  "McpConnectionFailed",
  { message: Schema.String },
) {}
const json = <A>(request: HttpClientRequest.HttpClientRequest, schema: Schema.Decoder<A>) =>
  HttpClient.execute(request).pipe(
    Effect.mapError(
      () =>
        new McpConnectionFailed({
          message: "Cannot reach Executor. Check that the local server is running.",
        }),
    ),
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? response.json.pipe(
            Effect.mapError(
              () =>
                new McpConnectionFailed({ message: "The connection response could not be read." }),
            ),
          )
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
    Effect.provide(dashboardHttpClient),
  );
/** Registered client metadata is loaded from the issuer, never trusted from a URL label. */
export const localMcpClientAtom = Atom.family((id: string) =>
  BrowserAtoms.atom(
    json(
      HttpClientRequest.get(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(id)}`),
      Schema.Struct({ client_name: Schema.optionalKey(Schema.String) }),
    ),
  ),
);
/** Pairing cookies authorize the selected grant; no MCP bearer key is sent from this page. */
export const localMcpConsentAtom = BrowserAtoms.fn((input: { accept: boolean; query: string }) =>
  HttpClientRequest.bodyJson(HttpClientRequest.post("/api/auth/oauth2/consent"), {
    accept: input.accept,
    oauth_query: input.query,
  }).pipe(
    Effect.mapError(
      () =>
        new McpConnectionFailed({
          message: "This connection could not be completed. Start again from your MCP client.",
        }),
    ),
    Effect.flatMap((request) => json(request, Schema.Struct({ url: Schema.NonEmptyString }))),
  ),
);
