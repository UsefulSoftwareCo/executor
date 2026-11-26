import type { ElicitationMode } from "@executor-js/mcp";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Duration, Effect, Schema } from "effect";
import { McpSchema, type McpServer } from "effect/ai";

const prefix = "mcp-session:";
const retention = Duration.toMillis(Duration.days(7));
const kept = 64;
const maximumLength = 16_384;

const SessionRecord = Schema.Struct({
  at: Schema.Number,
  session: Schema.Unknown,
});
const decodeRecord = Schema.decodeUnknownOption(SessionRecord);
const decodeLogLevel = Schema.decodeUnknownOption(
  Schema.Struct({ logLevel: McpSchema.LoggingLevel }),
);

type Loaded =
  | { readonly _tag: "missing" | "expired" | "invalid" }
  | { readonly _tag: "restored"; readonly session: unknown };

export const mcpSessionStore =
  (storage: Cloudflare.DurableObjectStorage) =>
  (mode: ElicitationMode): McpServer.SessionStore => {
    const kv = storage.kv;
    const key = (sessionId: string) => `${prefix}${mode}:${sessionId}`;
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
        Effect.catchCause(() =>
          Effect.annotateCurrentSpan("executor.mcp.session.restore", "failed"),
        ),
        Effect.withSpan("mcp.session.restore"),
      );
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
