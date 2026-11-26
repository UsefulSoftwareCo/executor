import {
  dashboardHttpClient,
  hydrated,
  hydratedResult,
  requestKey,
} from "@executor-js/ui/contracts/http";
import { DashboardClient } from "./api.ts";

export const mcpInstallationAtom = DashboardClient.query(
  "dashboard",
  "mcpInstallation",
  hydrated({}),
);

import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { grantSettingsHeader, type GrantSettings } from "@executor-js/mcp-auth/grants";
import { Atom } from "effect/reactivity";
import { BrowserAtoms } from "./telemetry.ts";

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
const LocalMcpClient = Schema.Struct({ client_name: Schema.optionalKey(Schema.String) });
export const localMcpClientAtom = Atom.family((id: string) =>
  BrowserAtoms.atom(
    json(
      HttpClientRequest.get(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(id)}`),
      LocalMcpClient,
    ),
  ).pipe(
    hydratedResult({
      key: `local:mcp-client:${requestKey({ id })}`,
      success: LocalMcpClient,
      error: McpConnectionFailed,
    }),
  ),
);
export const localMcpConsentAtom = BrowserAtoms.fn(
  (input: { accept: boolean; query: string; settings?: GrantSettings | undefined }) =>
    HttpClientRequest.bodyJson(
      HttpClientRequest.post("/api/auth/oauth2/consent").pipe(
        input.accept && input.settings !== undefined
          ? HttpClientRequest.setHeader(grantSettingsHeader, JSON.stringify(input.settings))
          : (request) => request,
      ),
      { accept: input.accept, oauth_query: input.query },
    ).pipe(
      Effect.mapError(
        () =>
          new McpConnectionFailed({
            message: "This connection could not be completed. Start again from your MCP client.",
          }),
      ),
      Effect.flatMap((request) => json(request, Schema.Struct({ url: Schema.NonEmptyString }))),
    ),
);
