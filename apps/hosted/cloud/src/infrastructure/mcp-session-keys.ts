/**
 * The keys that sign MCP session ids (`implementation/mcp-session-id.ts`). Alchemy mints each one
 * once per stage and binds it into the API Worker, which verifies, and the MCP server Worker, whose
 * session objects sign. Nothing else receives them.
 *
 * Session objects keep their protocol sessions in storage, so an id outlives deploys. The gateway
 * accepts an id only while the key that signed it is `current` or `previous`: after a rotation
 * retires that key, the id is refused (404) and the client initializes again, which issues an id
 * signed by a current key. `previous` covers the deploy skew between the API Worker and the MCP
 * server Worker, which deploy separately, and ids issued before the swap. Rotation takes three deploys:
 * 1. Give `previous` a new logical id. Alchemy mints a fresh key that only verifies.
 * 2. Swap the two ids: the fresh key signs, the old one still verifies through the deploy's skew.
 * 3. Give `previous` another new id, which retires the old key everywhere.
 */
import { Random } from "alchemy";
import { Effect, Redacted } from "effect";
import { importMcpSessionKey, type McpSessionKeys } from "../implementation/mcp-session-id.ts";

const keyIds = { current: "McpSessionKeyA", previous: "McpSessionKeyB" } as const;

/** Bind both keys at initialization; read and import them inside an invocation. */
export const mcpSessionKeys = Effect.gen(function* () {
  const current = yield* (yield* Random(keyIds.current, { bytes: 32 })).text;
  const previous = yield* (yield* Random(keyIds.previous, { bytes: 32 })).text;
  // CryptoKeys hold no I/O, so one import serves every later request of the isolate.
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
