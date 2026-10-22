import { Effect, Predicate, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { McpClientFrame } from "@executor-js/host-mcp/in-memory-client-bridge";
import { McpAuthProvider } from "@executor-js/host-mcp";
import { SelfHostMcpClientBridge } from "./auth";

const McpClientManifestSchema = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      inputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  resources: Schema.Array(
    Schema.Struct({
      uri: Schema.String,
      name: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
      mimeType: Schema.optional(Schema.String),
    }),
  ),
  prompts: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      arguments: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            description: Schema.optional(Schema.String),
            required: Schema.optional(Schema.Boolean),
          }),
        ),
      ),
    }),
  ),
});
const hasManifestShape = Schema.is(McpClientManifestSchema);

export const MCP_CLIENT_CHANNEL_MAX_FRAME_LENGTH = 65_536;

export const isClientChannelFrameWithinLimit = (raw: string): boolean =>
  raw.length <= MCP_CLIENT_CHANNEL_MAX_FRAME_LENGTH;

export const isValidMcpClientManifest = (
  value: unknown,
): value is Schema.Schema.Type<typeof McpClientManifestSchema> => {
  if (!hasManifestShape(value)) return false;
  const nameGroups = [
    value.tools.map((item) => item.name),
    value.resources.map((item) => item.uri),
    value.prompts.map((item) => item.name),
  ];
  return (
    value.tools.length + value.resources.length + value.prompts.length <= 100 &&
    nameGroups.every(
      (names) =>
        names.every((name) => name.length > 0 && name.length <= 200) &&
        new Set(names).size === names.length,
    )
  );
};

const response = (status: number, message: string, headers?: HeadersInit) =>
  HttpServerResponse.text(message, { status, headers });

export const hasAllowedCookieOrigin = (
  request: Request,
  allowedOrigins: ReadonlyArray<string>,
): boolean => {
  if (!request.headers.has("cookie")) return true;
  const origin = request.headers.get("origin");
  return origin !== null && allowedOrigins.includes(origin);
};

const routeFor = (allowedOrigins: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const incoming = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* McpAuthProvider;
    const bridge = yield* SelfHostMcpClientBridge;
    const webRequest =
      incoming.source instanceof Request
        ? incoming.source
        : new Request(
            new URL(
              incoming.url,
              `http://${(incoming.headers as Record<string, string>).host ?? "host.internal"}`,
            ),
            {
              method: "GET",
              headers: new Headers(incoming.headers as Record<string, string>),
            },
          );
    if (!hasAllowedCookieOrigin(webRequest, allowedOrigins)) {
      return response(403, "Forbidden");
    }
    const outcome = yield* auth.authenticate(webRequest);
    if (!Predicate.isTagged("Authenticated")(outcome)) {
      const challenge = Predicate.isTagged("Unauthorized")(outcome)
        ? (outcome.challenge ??
          `Bearer resource_metadata="${auth.resourceMetadataUrl(webRequest)}"`)
        : undefined;
      return response(
        401,
        "Unauthorized",
        challenge ? { "www-authenticate": challenge } : undefined,
      );
    }

    const socket = yield* incoming.upgrade;
    const write = yield* socket.writer;
    const context = yield* Effect.context<never>();
    let connection: ReturnType<typeof bridge.connect> | null = null;
    let initialized = false;

    yield* socket
      .runString((raw) =>
        Effect.gen(function* () {
          if (!isClientChannelFrameWithinLimit(raw)) {
            yield* write(JSON.stringify({ type: "error", message: "Client frame too large" }));
            return;
          }
          const message = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(raw).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (typeof message !== "object" || message === null) return;
          const frame = message as Record<string, unknown>;

          if (!initialized) {
            if (frame.type !== "initialize" || !isValidMcpClientManifest(frame.manifest)) {
              yield* write(JSON.stringify({ type: "error", message: "Invalid initial manifest" }));
              return;
            }
            initialized = true;
            connection = bridge.connect({
              principal: outcome.principal,
              manifest: frame.manifest,
              send: (outbound: McpClientFrame) => {
                // The bridge transport contract is synchronous; schedule writes
                // on the acquired Effect socket writer.
                void Effect.runPromiseWith(context)(write(JSON.stringify(outbound)));
              },
            });
            const binding = bridge.getBinding(connection.bindingToken, outcome.principal);
            if (binding === null) {
              connection.disconnect();
              connection = null;
              yield* write(JSON.stringify({ type: "error", message: "Unable to create binding" }));
              return;
            }
            yield* write(
              JSON.stringify({
                type: "bound",
                bindingToken: connection.bindingToken,
                clientIdentity: binding.clientIdentity,
                manifestGeneration: connection.manifestGeneration,
              }),
            );
            return;
          }

          if (!connection || typeof frame.id !== "string") return;
          if (Object.hasOwn(frame, "error")) connection.respond(frame.id, undefined, frame.error);
          else if (Object.hasOwn(frame, "result")) connection.respond(frame.id, frame.result);
        }),
      )
      .pipe(Effect.ensuring(Effect.sync(() => connection?.disconnect())));

    return HttpServerResponse.empty();
  });

/** Effect HTTP route for the authenticated, persistent client link. */
export const makeMcpClientChannelRoute = (allowedOrigins: ReadonlyArray<string>) =>
  HttpRouter.add("GET", "/api/mcp/client-channel", routeFor(allowedOrigins));
