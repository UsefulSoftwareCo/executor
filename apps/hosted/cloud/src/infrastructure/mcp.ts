import { cloudArtifactsTokensLive } from "./artifacts-tokens.ts";
/** Native Effect MCP protocol sessions; product data and grants stay in Postgres. */
import { traceHeaders } from "@executor-js/telemetry";
import {
  CurrentUserId,
  authenticatedMcp,
  browserMcpRequest,
  hostedMcpApproval,
  dispatchHostedMcp,
  makeHostedMcp,
  mcpSessionKey,
} from "@executor-js/hosted-server";
import * as Cloudflare from "alchemy/Cloudflare";
import { cloudAnalytics } from "../implementation/product-analytics.ts";
import { cloudSentry } from "../implementation/error-reporting.ts";
import { cloudTelemetry } from "./telemetry.ts";
import { Effect, Layer } from "effect";
import { HttpServer, HttpServerRequest } from "effect/unstable/http";
import { cloudAuth } from "./auth.ts";
import { cloudExecutor } from "./executor.ts";
import { cloudAuthDatabase } from "./auth-database.ts";
import { AppDataSupervisor, AppDataSupervisorLive } from "./app-data.ts";
import { unavailableAuthEmail } from "../contracts/email.ts";
import { forwardMcpRequest } from "../implementation/mcp-forward.ts";
import { observeMcpStream } from "../implementation/mcp-stream-observability.ts";

const makeMcpSessions = Effect.gen(function* () {
  const reportErrors = yield* cloudSentry;
  const auth = yield* cloudAuth(unavailableAuthEmail);
  const executor = yield* cloudExecutor(yield* AppDataSupervisor, yield* cloudArtifactsTokensLive);
  const analytics = yield* cloudAnalytics;
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    // Opaque object identity is stable across activations; the random activation
    // identifies a fresh in-memory MCP registry without recording session tokens.
    const activation = yield* Effect.sync(() => crypto.randomUUID());
    const handler = yield* makeHostedMcp().pipe(Effect.provide(HttpServer.layerServices));
    const browser = browserMcpRequest((access, address) =>
      hostedMcpApproval(handler.approvals, access, address).pipe(
        Effect.provideService(CurrentUserId, access.userId),
      ),
    ).pipe(
      Effect.provide(executor),
      Effect.provide(auth.mcpIdentity),
      Effect.provide(HttpServer.layerServices),
    );
    const http = authenticatedMcp((access) =>
      dispatchHostedMcp(access, handler.http).pipe(
        Effect.provideService(CurrentUserId, access.userId),
      ),
    ).pipe(
      Effect.provide(executor),
      Effect.provide(auth.mcpIdentity),
      Effect.provide(HttpServer.layerServices),
    );
    return {
      fetch: Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        new URL(request.url, "https://mcp.internal").pathname.startsWith("/api/mcp/approvals/")
          ? browser
          : http,
      ).pipe(
        Effect.flatMap(observeMcpStream("session")),
        Effect.tap((response) =>
          Effect.annotateCurrentSpan("http.response.status_code", response.status),
        ),
        Effect.withSpan("mcp.session.request", {
          attributes: {
            "executor.mcp.object_id": state.id.toString(),
            "executor.mcp.activation_id": activation,
          },
        }),
        analytics.wrap,
        reportErrors,
      ),
    };
  });
}).pipe(
  Effect.provide(Layer.mergeAll(AppDataSupervisorLive, cloudAuthDatabase, cloudTelemetry)),
  Effect.orDie,
);

/** The gateway selects one private object per authenticated user/client/organization. */
export class McpSessions extends Cloudflare.DurableObject<
  McpSessions,
  Effect.Success<Effect.Success<typeof makeMcpSessions>>
>()("McpSessions") {}

/** The API owns the sessions and supplies their private service bindings. */
export const McpSessionsLive = McpSessions.make(makeMcpSessions);

/** Resolve the session binding at startup; return a handler authenticated on each request. */
export const cloudMcp = Effect.gen(function* () {
  const sessions = yield* McpSessions;
  const forward = (access: Parameters<typeof mcpSessionKey>[0]) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const headers = yield* traceHeaders;
      const traced = request.modify({ headers: { ...request.headers, ...headers } });
      return yield* forwardMcpRequest(traced, (attempt) =>
        sessions.getByName(mcpSessionKey(access)).fetch(attempt),
      );
    }).pipe(Effect.flatMap(observeMcpStream("gateway")), Effect.withSpan("mcp.session.forward"));
  return {
    http: authenticatedMcp(forward),
    approvals: browserMcpRequest((access) => forward(access)),
  };
});
