/**
 * MCP session ids that name their session object, so the gateway can route a request inside a
 * session without checking its bearer first.
 *
 * A session object answers `initialize` with `Mcp-Session-Id: <objectId>.<mac>.<sessionId>`:
 * its own Durable Object id, an HMAC-SHA256 over that id and the protocol's session id, and the
 * protocol's session id. The gateway routes only ids whose mac verifies, so it reaches only
 * objects that issued a session after an authenticated request; every other id is answered as an
 * unknown session before any object or database is touched. The object still checks the bearer
 * on every request and that its key names this object (`mcp-session.ts`).
 */
import { Effect, Option } from "effect";
import { HttpServerResponse } from "effect/http";

/**
 * Carry the organization the object authenticated to the gateway, which records it on its forward
 * and removes it: a request routed by its session id is not authenticated in the gateway. The
 * object sets it only once the bearer's own key names it. The user is not carried: an older
 * gateway during a deploy would pass a new header through to the client.
 */
export const sessionOrganizationHeader = "x-executor-session-organization";

/** The key that signs new session ids, and the one before it, which still verifies them. */
export interface McpSessionKeys {
  readonly current: CryptoKey;
  readonly previous: CryptoKey;
}

/** The parts of a signed session id; `sessionId` is the one the protocol server issued. */
export interface McpSessionAddress {
  readonly objectId: string;
  readonly sessionId: string;
}

/** A Durable Object id is 32 bytes in lowercase hex. */
const objectIdPattern = /^[0-9a-f]{64}$/u;
/** Effect's MCP server names sessions with `crypto.randomUUID()`. */
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** A full HMAC-SHA256, unpadded base64url. */
const macPattern = /^[A-Za-z0-9_-]{43}$/u;

/** The id and session are fixed-format, so the separator cannot be moved between them. */
const signed = (objectId: string, sessionId: string) =>
  new TextEncoder().encode(`executor mcp session\n${objectId}\n${sessionId}`);

/** Import one 32-byte hex key. Keys are not extractable; a key of any other length is a defect. */
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
/** The id a session object issues for one of its protocol sessions. */
export const signMcpSessionId = (keys: McpSessionKeys, address: McpSessionAddress) =>
  Effect.promise(() =>
    crypto.subtle.sign("HMAC", keys.current, signed(address.objectId, address.sessionId)),
  ).pipe(
    Effect.map(
      (mac) => `${address.objectId}.${Buffer.from(mac).toString("base64url")}.${address.sessionId}`,
    ),
  );

/** Split a session id into its parts without checking the mac. */
export const parseMcpSessionId = (value: string) => {
  const parts = value.split(".");
  if (parts.length !== 3) return Option.none();
  const [objectId = "", mac = "", sessionId = ""] = parts;
  return objectIdPattern.test(objectId) && macPattern.test(mac) && sessionIdPattern.test(sessionId)
    ? Option.some({ objectId, mac, sessionId })
    : Option.none();
};

/**
 * The address of a session id whose mac either key made. WebCrypto compares macs in constant
 * time; which key matched and whether the id was well formed are not secret.
 */
export const verifyMcpSessionId = (keys: McpSessionKeys, value: string) =>
  Effect.gen(function* () {
    const parsed = parseMcpSessionId(value);
    if (Option.isNone(parsed)) return Option.none<McpSessionAddress>();
    const { objectId, mac, sessionId } = parsed.value;
    const data = signed(objectId, sessionId);
    const signature = Buffer.from(mac, "base64url");
    // 43 characters carry 258 bits; only the canonical spelling of the 256-bit mac is accepted.
    if (signature.toString("base64url") !== mac) return Option.none<McpSessionAddress>();
    for (const key of [keys.current, keys.previous]) {
      const valid = yield* Effect.promise(() => crypto.subtle.verify("HMAC", key, signature, data));
      if (valid) return Option.some<McpSessionAddress>({ objectId, sessionId });
    }
    return Option.none<McpSessionAddress>();
  });

/**
 * The answer to an id no session object will serve, the same one Effect's MCP server gives an
 * unknown session (MCP 2025-11-25, Session Management): the client starts a new session.
 */
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
