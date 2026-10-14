/** One MCP session object: its protocol servers, held connections and request handling. */
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
import * as Cloudflare from "alchemy/Cloudflare";
import * as PgConnection from "@effect/sql-pg/PgConnection";
import { Effect, Option, type Layer, type Scope } from "effect";
import { HttpEffect, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { cloudSentry } from "../implementation/error-reporting.ts";
import {
  type McpSessionKeys,
  mcpSessionNotFound,
  parseMcpSessionId,
  sessionOrganizationHeader,
  signMcpSessionId,
} from "../implementation/mcp-session-id.ts";
import { makeAnswer } from "../implementation/mcp-session-timing.ts";
import { observeMcpStream } from "../implementation/mcp-stream-observability.ts";
import { cloudAnalytics } from "../implementation/product-analytics.ts";
import type { cloudServingProduct } from "./serving-product.ts";
import { isolateDeclarations } from "./isolate-memory.ts";
import { cloudObjectDatabase, ObjectDatabase } from "./object-database.ts";
import { mcpSessionStore } from "./mcp-session-store.ts";

/**
 * The isolate's executor and MCP identity, built once and shared by every session object in
 * it. Both use the calling object's held database connections.
 */
export interface McpSessionServices {
  readonly executor: Effect.Success<ReturnType<typeof cloudServingProduct>>;
  readonly identity: Layer.Layer<McpAuthentication>;
  /** Signs the ids of this object's sessions (`mcp-session-keys.ts`). */
  readonly keys: Effect.Effect<McpSessionKeys>;
  /** Names the object a caller's key selects. */
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
  const objectDatabase = yield* cloudObjectDatabase;
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    // Every request and MCP operation of this session shares the object's connections.
    const database = yield* objectDatabase(`mcp ${state.id.toString()}`);
    // Opaque object identity is stable across activations; the random activation
    // identifies a fresh in-memory MCP registry without recording session tokens.
    const activation = yield* Effect.sync(() => crypto.randomUUID());
    const answer = makeAnswer(() => {
      const kept = isolateDeclarations.usage();
      return {
        "executor.mcp.isolate.programs": runningPrograms(),
        "executor.mcp.isolate.kept_entries": kept.entries,
        "executor.mcp.isolate.kept_bytes": kept.bytes,
      };
    });
    // What each caller's last tool call read, by app and named accounts (CallStateCache).
    const callState = new Map<string, CallState>();
    // Protocol sessions are kept in the object's storage, so they outlive its eviction.
    const handler = yield* makeHostedMcp(undefined, undefined, mcpSessionStore(state.storage)).pipe(
      Effect.provide(HttpServer.layerServices),
    );
    const objectId = state.id.toString();
    /**
     * A request may reach this object by a session id alone, so before any work it must carry a
     * bearer whose own key names this object. The key comes only from the verified bearer. Any
     * other caller gets the answer an unknown session gets, which does not reveal the session.
     */
    const bound = <E, R>(
      access: McpAccess,
      work: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ) =>
      Effect.flatMap(idFromName, (named) =>
        named(mcpSessionKey(access)).equals(state.id)
          ? work.pipe(
              Effect.map(
                HttpServerResponse.setHeader(sessionOrganizationHeader, access.access.organization),
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
        dispatchHostedMcp(access, address, handler.http).pipe(
          Effect.provideService(CurrentUserId, access.userId),
          // The object's pool groups statements (`object-database.ts`): a group's concurrent reads
          // share a write on a connection of their own.
          Effect.provideService(ConcurrentStatements, { group: PgPool.grouped }),
          // One write and one read-only snapshot per batch: `pipelined` in the @effect/sql-pg patch.
          // Held (`PgPool.held`): nobody awaits the batch's `COMMIT`, so only a hold keeps its
          // connection to the batch until `COMMIT` answers; the batch refuses to write `BEGIN` on a
          // connection that is not held.
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
    /**
     * Effect's MCP server sees only the protocol's own session id: the object removes its prefix
     * from a request and signs the id the server issues. The gateway verified the prefix's mac; an
     * id naming another object names no session here.
     */
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
        // Effect adds the issued id in its own pre-response handler, which runs before this one.
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
        addressed(
          new URL(request.url, "https://mcp.internal").pathname.startsWith("/api/mcp/approvals/")
            ? browser
            : http,
        ),
      ).pipe(
        Effect.flatMap(observeMcpStream("session")),
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
      ),
    } satisfies McpSessionHandler;
  });
});

/**
 * The object supplies only the request and its scope. Everything else a session reads must come
 * from {@link McpSessionServices}, or this fails to typecheck rather than at the first request.
 */
interface McpSessionHandler {
  readonly fetch: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >;
}

/** What the gateway binds on a session object. */
export type McpSessionObject = Effect.Success<Effect.Success<ReturnType<typeof makeMcpSession>>>;
