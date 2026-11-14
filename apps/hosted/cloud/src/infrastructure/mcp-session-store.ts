/**
 * Keeps a session object's MCP protocol sessions in the object's own storage, so a session
 * outlives the object's eviction or a deploy: the next request restores it instead of answering
 * 404 and making the client initialize again.
 *
 * A record holds only what `initialize` negotiated (version, client capabilities and info) and
 * the log level the client set. It grants nothing: every request is authenticated, and its
 * bearer must name this object, before the protocol server reads a record (`mcp-session.ts`).
 * Programs, approvals and held connections stay in memory: an object holding a program keeps
 * itself in memory until it ends (`mcp-session.ts`), and a restart still loses it, which the
 * object's record of issued requests reports (`mcp-interaction-store.ts`).
 *
 * Writes happen on `initialize`, on `logging/setLevel` and once per restore, never on other
 * requests. Reads happen only for a session id the object's memory does not hold.
 *
 * Each save or load reads, decides and writes in one synchronous step, through the object's
 * synchronous key-value storage. An object runs one piece of JavaScript at a time, so no other
 * request (of either elicitation mode) can act between a step's read and its writes: a prune
 * never works from a list older than a concurrent restore, and a restore never writes back a
 * record a prune removed. A load refreshes a record only after the protocol server has decoded
 * it and registered the session, within the same step; a record it cannot use is deleted.
 * Writes made with no await between them also commit together.
 */
import type { ElicitationMode } from "@executor-js/mcp";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Duration, Effect, Schema } from "effect";
import { McpSchema, type McpServer } from "effect/ai";

const prefix = "mcp-session:";
/** A session unused for this long is forgotten; the client initializes again, as before. */
const retention = Duration.toMillis(Duration.days(7));
/** Sessions kept per object; the least recently used go first. */
const kept = 64;
/** A larger `initialize` (its capabilities and `_meta` are the client's) stays in memory only. */
const maximumLength = 16_384;

const SessionRecord = Schema.Struct({
  /** When the session was opened or last restored. */
  at: Schema.Number,
  session: Schema.Unknown,
});
const decodeRecord = Schema.decodeUnknownOption(SessionRecord);
/** The level a client set, recorded on the restore span: one of MCP's eight levels. */
const decodeLogLevel = Schema.decodeUnknownOption(
  Schema.Struct({ logLevel: McpSchema.LoggingLevel }),
);

type Loaded =
  | { readonly _tag: "missing" | "expired" | "invalid" }
  | { readonly _tag: "restored"; readonly session: unknown };

/** One store per elicitation mode: a session belongs to the mode that opened it. */
export const mcpSessionStore =
  (storage: Cloudflare.DurableObjectStorage) =>
  (mode: ElicitationMode): McpServer.SessionStore => {
    const kv = storage.kv;
    const key = (sessionId: string) => `${prefix}${mode}:${sessionId}`;
    // The object's sessions across modes, beyond `kept` by last use, or older than `retention`.
    const prune = (now: number) => {
      const ages = Array.from(kv.list({ prefix }), ([name, value]) => {
        const record = decodeRecord(value);
        return { name, at: record._tag === "Some" ? record.value.at : 0 };
      }).sort((a, b) => b.at - a.at);
      for (const [index, { name, at }] of ages.entries()) {
        if (index >= kept || now - at > retention) kv.delete(name);
      }
    };
    const save = (sessionId: string, session: McpServer.StoredSession) =>
      Effect.gen(function* () {
        if (JSON.stringify(session).length > maximumLength) {
          yield* Effect.annotateCurrentSpan("executor.mcp.session.store", "too_large");
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sync(() => {
          kv.put(key(sessionId), { at: now, session });
          prune(now);
        });
      });
    const load = (sessionId: string, restore: (stored: unknown) => boolean) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const loaded = yield* Effect.sync((): Loaded => {
          const stored = kv.get(key(sessionId));
          if (stored === undefined) return { _tag: "missing" };
          const record = decodeRecord(stored);
          if (record._tag === "Some" && now - record.value.at > retention) {
            kv.delete(key(sessionId));
            return { _tag: "expired" };
          }
          // A record the server cannot use (unreadable, or a version it no longer serves) would
          // only answer 404 again: forget it rather than keep it alive.
          if (record._tag === "None" || !restore(record.value.session)) {
            kv.delete(key(sessionId));
            return { _tag: "invalid" };
          }
          kv.put(key(sessionId), { at: now, session: record.value.session });
          return { _tag: "restored", session: record.value.session };
        });
        yield* Effect.annotateCurrentSpan("executor.mcp.session.restore", loaded._tag);
        if (loaded._tag !== "restored") return;
        const level = decodeLogLevel(loaded.session);
        yield* Effect.annotateCurrentSpan(
          "executor.mcp.session.log_level",
          level._tag === "Some" ? level.value.logLevel : "default",
        );
      }).pipe(
        // A read that fails leaves the id unknown (404), as it was before this store.
        Effect.catchCause(() =>
          Effect.annotateCurrentSpan("executor.mcp.session.restore", "failed"),
        ),
        Effect.withSpan("mcp.session.restore"),
      );
    // A storage call that throws does not fail the client's request: a session it could not save
    // is kept in memory only, and one it could not read is unknown (404). A write that fails later,
    // when the object's storage commits, is not caught here: the runtime then discards the
    // response and restarts the object, and the client sees an error.
    return {
      save: (sessionId, session) =>
        save(sessionId, session).pipe(
          Effect.catchCause(() =>
            Effect.annotateCurrentSpan("executor.mcp.session.store", "failed"),
          ),
        ),
      load,
    };
  };
