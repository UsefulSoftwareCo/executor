import { Effect, Option } from "effect";
import { HttpServerResponse } from "effect/http";

export const sessionOrganizationHeader = "x-executor-session-organization";

export interface McpSessionKeys {
  readonly current: CryptoKey;
  readonly previous: CryptoKey;
}

export interface McpSessionAddress {
  readonly objectId: string;
  readonly sessionId: string;
}

const objectIdPattern = /^[0-9a-f]{64}$/u;
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const macPattern = /^[A-Za-z0-9_-]{43}$/u;

const signed = (objectId: string, sessionId: string) =>
  new TextEncoder().encode(`executor mcp session\n${objectId}\n${sessionId}`);

export const importMcpSessionKey = (hex: string) =>
  Effect.gen(function* () {
    const raw = Buffer.from(hex, "hex");
    if (!/^[0-9a-f]{64}$/u.test(hex) || raw.length !== 32)
      return yield* Effect.die(new Error("An MCP session key must be 32 hex-encoded bytes"));
    return raw;
  }).pipe(
    Effect.flatMap((raw) =>
      Effect.promise(() =>
        crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
          "sign",
          "verify",
        ]),
      ),
    ),
  );
export const signMcpSessionId = (keys: McpSessionKeys, address: McpSessionAddress) =>
  Effect.promise(() =>
    crypto.subtle.sign("HMAC", keys.current, signed(address.objectId, address.sessionId)),
  ).pipe(
    Effect.map(
      (mac) => `${address.objectId}.${Buffer.from(mac).toString("base64url")}.${address.sessionId}`,
    ),
  );

export const parseMcpSessionId = (value: string) => {
  const parts = value.split(".");
  if (parts.length !== 3) return Option.none();
  const [objectId = "", mac = "", sessionId = ""] = parts;
  return objectIdPattern.test(objectId) && macPattern.test(mac) && sessionIdPattern.test(sessionId)
    ? Option.some({ objectId, mac, sessionId })
    : Option.none();
};

export const verifyMcpSessionId = (keys: McpSessionKeys, value: string) =>
  Effect.gen(function* () {
    const parsed = parseMcpSessionId(value);
    if (Option.isNone(parsed)) return Option.none<McpSessionAddress>();
    const { objectId, mac, sessionId } = parsed.value;
    const data = signed(objectId, sessionId);
    const signature = Buffer.from(mac, "base64url");
    if (signature.toString("base64url") !== mac) return Option.none<McpSessionAddress>();
    for (const key of [keys.current, keys.previous]) {
      const valid = yield* Effect.promise(() => crypto.subtle.verify("HMAC", key, signature, data));
      if (valid) return Option.some<McpSessionAddress>({ objectId, sessionId });
    }
    return Option.none<McpSessionAddress>();
  });

export const mcpSessionNotFound = () =>
  HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message:
          "Session not found: this Mcp-Session-Id is unknown or has expired, for example after a server restart. Start a new session by sending initialize without an Mcp-Session-Id header",
      },
    },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
