import { DurableObject } from "cloudflare:workers";
import { mcpClientChannelIdFromName } from "@executor-js/cloudflare/mcp/execution-owner-directory";
import { Data, Effect, Exit, Option, Schema } from "effect";

import {
  createClientChannelState,
  filterClientManifestResponse,
  routeClientRequest,
  type ClientChannelSnapshot,
  type ClientManifest,
  type ClientPrincipal,
} from "./client-channel";

export type PendingClientInvocation = {
  readonly resume: (effect: Effect.Effect<unknown, McpClientChannelError>) => void;
  readonly timeout?: ReturnType<typeof setTimeout>;
};

class McpClientChannelError extends Data.TaggedError("McpClientChannelError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

const decodeClientFrame = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const dispatchClientInvocation = (
  pending: Map<string, PendingClientInvocation>,
  id: string,
  socket: Pick<WebSocket, "send">,
  method: string,
  params: unknown,
): Promise<unknown> =>
  Effect.runPromise(
    Effect.callback<unknown, McpClientChannelError>((resume) => {
      const timeout = setTimeout(() => {
        if (pending.delete(id))
          resume(Effect.fail(new McpClientChannelError({ reason: "Client invocation timed out" })));
      }, 30_000);
      pending.set(id, { resume, timeout });
      const sent = Effect.runSyncExit(
        Effect.try({
          try: () => socket.send(JSON.stringify({ id, method, params })),
          catch: () => new McpClientChannelError({ reason: "Client invocation delivery failed" }),
        }),
      );
      if (Exit.isFailure(sent)) {
        pending.delete(id);
        clearTimeout(timeout);
        resume(
          Effect.fail(new McpClientChannelError({ reason: "Client invocation delivery failed" })),
        );
      }
      return Effect.sync(() => {
        pending.delete(id);
        clearTimeout(timeout);
      });
    }),
  );

export const resolveClientInvocationResponse = (
  pending: Map<string, PendingClientInvocation>,
  binding: string,
  frame: unknown,
): boolean => {
  if (
    typeof frame !== "object" ||
    frame === null ||
    !("id" in frame) ||
    typeof frame.id !== "string" ||
    !frame.id.startsWith(`${binding}:`)
  )
    return false;
  const request = pending.get(frame.id);
  if (!request) return false;
  pending.delete(frame.id);
  if (request.timeout !== undefined) clearTimeout(request.timeout);
  if ("error" in frame)
    request.resume(Effect.fail(new McpClientChannelError({ reason: "Client invocation failed" })));
  else if ("result" in frame) request.resume(Effect.succeed(frame.result));
  else
    request.resume(
      Effect.fail(new McpClientChannelError({ reason: "Invalid client invocation response" })),
    );
  return true;
};

/** Per-client durable router. All identity inputs must originate from the
 * Worker after cloudMcpAuth succeeds; client messages never supply identity. */
export class McpClientChannelDO extends DurableObject {
  private statePromise: Promise<ReturnType<typeof createClientChannelState>>;
  private readonly pending = new Map<string, PendingClientInvocation>();
  private sequence = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.statePromise = ctx.blockConcurrencyWhile(async () => {
      const snapshot = await ctx.storage.get<ClientChannelSnapshot>("clients");
      return createClientChannelState(snapshot);
    });
  }

  async register(principal: ClientPrincipal, manifest: ClientManifest, clientId: string) {
    const state = await this.statePromise;
    const binding = state.register(principal, manifest, clientId);
    if (typeof binding === "string") await this.ctx.storage.put("clients", state.snapshot());
    return binding;
  }

  async route(binding: string, generation: number, request: unknown) {
    const state = await this.statePromise;
    return routeClientRequest(state, binding, generation, request);
  }

  async filterResponse(binding: string, method: string, response: unknown) {
    const state = await this.statePromise;
    return filterClientManifestResponse(state, binding, method, response);
  }

  async getManifest(binding: string) {
    const state = await this.statePromise;
    const entry = state.get(binding);
    return entry?.connected ? entry.manifest : null;
  }

  async authenticate(token: string | null) {
    const state = await this.statePromise;
    if (!token) return null;
    const entry = state.get(token);
    return entry?.connected
      ? { binding: token, generation: entry.generation, principal: entry.principal }
      : null;
  }

  async revoke(binding: string) {
    const state = await this.statePromise;
    state.disconnect(binding);
    await this.ctx.storage.put("clients", state.snapshot());
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket")
      return new Response("Upgrade required", { status: 426 });
    const token = request.headers.get("x-executor-client-token");
    const identity = await this.authenticate(token);
    if (!identity) return new Response("Unauthorized", { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      binding: identity.binding,
      generation: identity.generation,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const body = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (body.length > 65_536) {
      socket.close(1009, "Message too large");
      return;
    }
    const attachmentExit = Effect.runSyncExit(
      Effect.try({
        try: () =>
          socket.deserializeAttachment() as {
            binding?: unknown;
            generation?: unknown;
          } | null,
        catch: () => new McpClientChannelError({ reason: "Invalid client attachment" }),
      }),
    );
    if (Exit.isFailure(attachmentExit)) {
      socket.close(1011, "Routing failed");
      return;
    }
    const attachment = attachmentExit.value;
    if (
      !attachment ||
      typeof attachment.binding !== "string" ||
      typeof attachment.generation !== "number"
    ) {
      socket.close(1008, "Invalid client binding");
      return;
    }
    const parsed = decodeClientFrame(body);
    if (Option.isNone(parsed)) {
      socket.close(1008, "Invalid client response");
      return;
    }
    if (resolveClientInvocationResponse(this.pending, attachment.binding, parsed.value)) return;
    socket.close(1008, "Uncorrelated client message");
  }
  async webSocketClose(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as { binding?: unknown } | null;
    if (typeof attachment?.binding === "string") {
      for (const [id, pending] of this.pending) {
        if (id.startsWith(`${attachment.binding}:`)) {
          this.pending.delete(id);
          if (pending.timeout !== undefined) clearTimeout(pending.timeout);
          pending.resume(Effect.fail(new McpClientChannelError({ reason: "Client disconnected" })));
        }
      }
      await this.revoke(attachment.binding);
    }
  }

  async invoke(
    binding: string,
    generation: number,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const state = await this.statePromise;
    const validation = routeClientRequest(state, binding, generation, { method, params });
    if (!validation.ok)
      return Effect.runPromise(
        Effect.fail(
          new McpClientChannelError({ reason: validation.error ?? "Client request denied" }),
        ),
      );
    const socket = this.ctx.getWebSockets().find((candidate) => {
      const attachment = candidate.deserializeAttachment() as {
        binding?: unknown;
        generation?: unknown;
      } | null;
      return attachment?.binding === binding && attachment.generation === generation;
    });
    if (!socket)
      return Effect.runPromise(
        Effect.fail(new McpClientChannelError({ reason: "Client is disconnected" })),
      );
    const id = `${binding}:${++this.sequence}`;
    return dispatchClientInvocation(this.pending, id, socket, method, params);
  }
}

/** Stable adapter for MCP session builders; caller supplies identity obtained
 * only from the verified cloud auth outcome. */
export const authenticatedClientChannel = (
  namespace: DurableObjectNamespace<McpClientChannelDO>,
  principal: ClientPrincipal,
  manifest: ClientManifest,
) => {
  const clientId = crypto.randomUUID();
  const stub = namespace.get(mcpClientChannelIdFromName(namespace, clientId));
  return {
    clientId,
    register: () => stub.register(principal, manifest, clientId),
    route: (generation: number, request: unknown) => stub.route(clientId, generation, request),
    filterResponse: (method: string, response: unknown) =>
      stub.filterResponse(clientId, method, response),
    revoke: () => stub.revoke(clientId),
    authenticate: (token: string) => stub.authenticate(token),
  };
};
