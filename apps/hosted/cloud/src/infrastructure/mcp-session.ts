import {
  CallStateCache,
  type CallState,
  ConcurrentStatements,
  StatementBatch,
  CurrentUserId,
  type McpAuthentication,
  authenticatedMcp,
  browserMcpRequest,
  hostedMcpApproval,
  dispatchHostedMcp,
  makeHostedMcp,
  type McpAccess,
  mcpSessionKey,
} from "@executor-js/hosted-server";
import { PgPool } from "@effect/sql-pg";
import { runningPrograms } from "@executor-js/mcp";
import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as PgConnection from "@effect/sql-pg/PgConnection";
import { Clock, Effect, Option, type Layer, type Scope } from "effect";
import { HttpEffect, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { cloudSentry } from "../implementation/error-reporting.ts";
import {
  type McpSessionKeys,
  mcpSessionNotFound,
  parseMcpSessionId,
  sessionOrganizationHeader,
  signMcpSessionId,
} from "../implementation/mcp-session-id.ts";
import { isolateTelemetryFlushes } from "@executor-js/telemetry/isolate";
import { makeAnswer } from "../implementation/mcp-session-timing.ts";
import { makeMcpFirstUse } from "../implementation/mcp-first-use.ts";
import { observeMcpStream } from "../implementation/mcp-stream-observability.ts";
import { cloudAnalytics } from "../implementation/product-analytics.ts";
import type { cloudServingProduct } from "./serving-product.ts";
import { isolateDeclarations } from "./isolate-memory.ts";
import { cloudDatabaseConnection } from "./database.ts";
import { cloudObjectDatabase, ObjectDatabase } from "./object-database.ts";
import { ObjectRequests, objectRequest } from "./served-request.ts";
import { interactionFaults } from "./mcp-interaction-faults.ts";
import { mcpInteractionStore } from "./mcp-interaction-store.ts";
import { mcpSessionStore } from "./mcp-session-store.ts";

const holdMillis = 30_000;

export interface McpSessionServices {
  readonly executor: Effect.Success<ReturnType<typeof cloudServingProduct>>;
  readonly identity: Layer.Layer<McpAuthentication>;
  readonly keys: Effect.Effect<McpSessionKeys>;
  readonly idFromName: Effect.Effect<(name: string) => { equals(other: unknown): boolean }>;
}

export const makeMcpSession = Effect.fn(function* ({
  executor,
  identity,
  keys,
  idFromName,
}: McpSessionServices) {
  const reportErrors = yield* cloudSentry;
  const analytics = yield* cloudAnalytics;
  const objectDatabase = yield* cloudObjectDatabase(cloudDatabaseConnection);
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const database = yield* objectDatabase(`mcp ${state.id.toString()}`);
    const activation = yield* Effect.sync(() => crypto.randomUUID());
    const answer = makeAnswer(() => {
      const kept = isolateDeclarations.usage();
      return {
        "executor.mcp.isolate.programs": runningPrograms(),
        "executor.mcp.isolate.kept_entries": kept.entries,
        "executor.mcp.isolate.kept_bytes": kept.bytes,
        "executor.telemetry.isolate.flushes": isolateTelemetryFlushes(),
      };
    });
    const callState = new Map<string, CallState>();
    const clock = yield* Clock.Clock;
    const faults = interactionFaults(state.storage.kv);
    const firstUse = makeMcpFirstUse(state.storage);
    const handler = yield* makeHostedMcp(
      undefined,
      undefined,
      mcpSessionStore(state.storage),
      mcpInteractionStore(faults.kv, () => clock.currentTimeMillisUnsafe()),
    ).pipe(Effect.provide(HttpServer.layerServices));
    const hold = Effect.gen(function* () {
      if (handler.programs() === 0) return;
      const now = yield* Clock.currentTimeMillis;
      const due = now + holdMillis;
      const set = yield* state.storage.getAlarm();
      if (set === null || set > due || set < now - holdMillis) yield* state.storage.setAlarm(due);
    });
    const objectId = state.id.toString();
    const requests = new ObjectRequests();
    const bound = <E, R>(
      access: McpAccess,
      work: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ) =>
      Effect.flatMap(idFromName, (named) =>
        named(mcpSessionKey(access)).equals(state.id)
          ? work.pipe(
              Effect.map(
                HttpServerResponse.setHeaders({
                  [sessionOrganizationHeader]: access.access.organization,
                }),
              ),
            )
          : Effect.annotateCurrentSpan("executor.mcp.session_binding", "refused").pipe(
              Effect.as(mcpSessionNotFound()),
            ),
      );
    const browser = browserMcpRequest((access, address) =>
      bound(
        access,
        hostedMcpApproval(handler.approvals, access, address).pipe(
          Effect.provideService(CurrentUserId, access.userId),
        ),
      ),
    ).pipe(
      Effect.provide(executor),
      Effect.provide(identity),
      Effect.provide(HttpServer.layerServices),
    );
    const http = authenticatedMcp((access, address) =>
      bound(
        access,
        firstUse(access, dispatchHostedMcp(access, address, handler.http)).pipe(
          Effect.provideService(CurrentUserId, access.userId),
          Effect.provideService(ConcurrentStatements, { group: PgPool.grouped }),
          Effect.provideService(StatementBatch, (leaves, { outside }) =>
            PgPool.held(
              PgConnection.pipelined(leaves, {
                outside,
                begin: "ISOLATION LEVEL REPEATABLE READ READ ONLY",
              }),
            ),
          ),
          Effect.provideService(CallStateCache, callState),
        ),
      ),
    ).pipe(
      Effect.provide(executor),
      Effect.provide(identity),
      Effect.provide(HttpServer.layerServices),
    );
    const addressed = <E, R>(handle: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const header = request.headers["mcp-session-id"];
        let routed = handle;
        if (header !== undefined) {
          const parsed = parseMcpSessionId(header);
          if (Option.isNone(parsed) || parsed.value.objectId !== objectId)
            return mcpSessionNotFound();
          const sessionId = parsed.value.sessionId;
          routed = handle.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              request.modify({ headers: { ...request.headers, "mcp-session-id": sessionId } }),
            ),
          );
        }
        const response = yield* routed;
        yield* HttpEffect.appendPreResponseHandler((_request, sent) => {
          const sessionId = sent.headers["mcp-session-id"];
          return sessionId === undefined
            ? Effect.succeed(sent)
            : keys.pipe(
                Effect.flatMap((current) => signMcpSessionId(current, { objectId, sessionId })),
                Effect.map((id) => HttpServerResponse.setHeader(sent, "mcp-session-id", id)),
              );
        });
        return response;
      });
    return {
      fetch: Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        faults.during(
          request,
          addressed(
            new URL(request.url, "https://mcp.internal").pathname.startsWith("/api/mcp/approvals/")
              ? browser
              : http,
          ),
        ),
      ).pipe(
        Effect.flatMap(observeMcpStream("session")),
        Effect.tap(() => hold.pipe(Effect.ignore)),
        Effect.tap((response) =>
          Effect.annotateCurrentSpan("http.response.status_code", response.status),
        ),
        answer,
        Effect.withSpan("mcp.session.request", {
          attributes: {
            "executor.mcp.object_id": state.id.toString(),
            "executor.mcp.activation_id": activation,
          },
        }),
        analytics.wrap,
        reportErrors,
        Effect.provideService(ObjectDatabase, database),
        objectRequest(requests),
      ),
      alarm: () => hold.pipe(Effect.ignore),
    } satisfies McpSessionHandler;
  });
});

interface McpSessionHandler {
  readonly fetch: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    HttpServerRequest.HttpServerRequest | Scope.Scope | RuntimeContext
  >;
  readonly alarm: () => Effect.Effect<void, never, RuntimeContext>;
}

export type McpSessionObject = Effect.Success<Effect.Success<ReturnType<typeof makeMcpSession>>>;
