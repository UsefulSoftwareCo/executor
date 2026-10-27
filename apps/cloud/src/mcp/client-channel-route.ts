import { Effect, Option, Predicate, Schema } from "effect";

import { mcpClientChannelIdFromName } from "@executor-js/cloudflare/mcp/execution-owner-directory";
import { McpAuthProvider } from "@executor-js/host-mcp";

import { cloudMcpAuth } from "./auth-provider";
import { isClientManifest } from "./client-channel";

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
const ClientManifestEnvelopeSchema = Schema.Struct({ manifest: Schema.Unknown });
const decodeClientManifestEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClientManifestEnvelopeSchema),
);

/** Worker-owned entry point. Registration always authenticates the ordinary
 * cloud bearer; client-supplied identity fields are never consumed. */
export const handleMcpClientChannel = async (request: Request, env: Env): Promise<Response> => {
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* McpAuthProvider;
      return yield* provider.authenticate(request);
    }).pipe(Effect.provide(cloudMcpAuth)),
  );
  if (!Predicate.isTagged(outcome, "Authenticated")) {
    const status = Predicate.isTagged(outcome, "Unauthorized")
      ? 401
      : Predicate.isTagged(outcome, "Forbidden")
        ? 403
        : 503;
    return json(
      { error: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Unavailable" },
      status,
    );
  }
  const token = request.headers.get("x-executor-client-token");
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (!token) return json({ error: "Client channel token required" }, 401);
    const stub = env.MCP_CLIENT_CHANNEL.get(
      mcpClientChannelIdFromName(env.MCP_CLIENT_CHANNEL, token),
    );
    const identity = await stub.authenticate(token);
    if (
      !identity ||
      identity.principal.accountId !== outcome.principal.accountId ||
      identity.principal.organizationId !== outcome.principal.organizationId
    )
      return json({ error: "Invalid client channel token" }, 401);
    return stub.fetch(request);
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const binding = crypto.randomUUID();
  const stub = env.MCP_CLIENT_CHANNEL.get(
    mcpClientChannelIdFromName(env.MCP_CLIENT_CHANNEL, binding),
  );
  if (Number(request.headers.get("content-length")) > 262_144) {
    return json({ error: "Client manifest too large" }, 413);
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 262_144) {
    return json({ error: "Client manifest too large" }, 413);
  }
  const decoded = decodeClientManifestEnvelope(rawBody);
  if (Option.isNone(decoded)) return json({ error: "Invalid client manifest" }, 400);
  const manifest = decoded.value.manifest;
  if (!isClientManifest(manifest)) return json({ error: "Invalid client manifest" }, 400);
  const registered = await stub.register(
    {
      accountId: outcome.principal.accountId,
      organizationId: outcome.principal.organizationId,
    },
    manifest,
    binding,
  );
  if (typeof registered !== "string") return json({ error: "Invalid client manifest" }, 400);
  return json(
    {
      token: registered,
      websocket: `${new URL(request.url).origin}/mcp/client-channel`,
      generation: 0,
    },
    201,
  );
};
