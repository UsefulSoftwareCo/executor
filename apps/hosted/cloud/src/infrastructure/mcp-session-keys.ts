import { Random } from "alchemy";
import { Effect, Redacted } from "effect";
import { importMcpSessionKey, type McpSessionKeys } from "../implementation/mcp-session-id.ts";

const keyIds = { current: "McpSessionKeyA", previous: "McpSessionKeyB" } as const;

export const mcpSessionKeys = Effect.gen(function* () {
  const current = yield* (yield* Random(keyIds.current, { bytes: 32 })).text;
  const previous = yield* (yield* Random(keyIds.previous, { bytes: 32 })).text;
  let imported: McpSessionKeys | undefined;
  return Effect.suspend(() =>
    imported !== undefined
      ? Effect.succeed(imported)
      : Effect.all({
          current: Effect.flatMap(current, (key) => importMcpSessionKey(Redacted.value(key))),
          previous: Effect.flatMap(previous, (key) => importMcpSessionKey(Redacted.value(key))),
        }).pipe(Effect.tap((keys) => Effect.sync(() => void (imported = keys)))),
  );
});
