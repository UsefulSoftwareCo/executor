import { Data, Effect, Exit, Match } from "effect";

import type { Principal } from "./seams";

export interface McpToolManifest {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

export interface McpResourceManifest {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpPromptManifest {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }[];
}

/** Server-owned capabilities for one connected client. Identity is never part of this value. */
export interface McpClientManifest {
  readonly tools: readonly McpToolManifest[];
  readonly resources: readonly McpResourceManifest[];
  readonly prompts: readonly McpPromptManifest[];
}

export type McpClientRequest =
  | {
      readonly method: "tools/call";
      readonly params: {
        readonly name: string;
        readonly arguments?: Readonly<Record<string, unknown>>;
      };
    }
  | { readonly method: "resources/read"; readonly params: { readonly uri: string } }
  | {
      readonly method: "prompts/get";
      readonly params: {
        readonly name: string;
        readonly arguments?: Readonly<Record<string, string>>;
      };
    };

export interface McpClientFrame {
  readonly id: string;
  readonly method: McpClientRequest["method"];
  readonly params: McpClientRequest["params"];
}

export interface McpBridgeConnection {
  readonly bindingToken: string;
  /** Pin this generation when creating an MCP session. */
  readonly manifestGeneration: number;
  readonly respond: (id: string, result: unknown, error?: unknown) => boolean;
  readonly disconnect: () => void;
}

export interface McpClientManifestSnapshot {
  readonly generation: number;
  readonly manifest: McpClientManifest;
}

/** The portion of a client bridge required to build a manifest-bound MCP session. */
export interface McpClientSessionResolver {
  readonly getManifestForIdentity: (
    clientIdentity: string,
    principal: Principal,
    generation: number,
  ) => McpClientManifest | null;
  readonly requestForIdentity: (
    clientIdentity: string,
    principal: Principal,
    generation: number,
    request: McpClientRequest,
  ) => Promise<unknown>;
}

export class McpClientBridgeError extends Data.TaggedError("McpClientBridgeError")<{
  readonly reason:
    | "disconnected"
    | "timeout"
    | "unauthenticated"
    | "capability-not-found"
    | "delivery"
    | "remote"
    | "stale-generation";
  readonly cause?: unknown;
  readonly expectedGeneration?: number;
  readonly actualGeneration?: number;
}> {
  override get message(): string {
    return Match.value(this.reason).pipe(
      Match.when("disconnected", () => "MCP client disconnected"),
      Match.when("timeout", () => "MCP client request timed out"),
      Match.when("unauthenticated", () => "MCP client not authenticated"),
      Match.when("capability-not-found", () => "MCP capability not found"),
      Match.when("delivery", () => "MCP frame delivery failed"),
      Match.when("remote", () => "MCP client returned an error"),
      Match.when(
        "stale-generation",
        () =>
          `MCP session generation is stale (expected ${this.expectedGeneration}, current ${this.actualGeneration})`,
      ),
      Match.exhaustive,
    );
  }
}

interface PendingRequest {
  readonly resume: (effect: Effect.Effect<unknown, McpClientBridgeError>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ClientRecord {
  readonly principal: Principal;
  readonly clientIdentity: string;
  readonly send: (frame: McpClientFrame) => void;
  readonly manifest: McpClientManifest;
  readonly manifestGeneration: number;
  active: boolean;
  readonly pending: Map<string, PendingRequest>;
}

const owns = (owner: Principal, principal: Principal): boolean =>
  owner.accountId === principal.accountId && owner.organizationId === principal.organizationId;

const opaqueId = (): string => globalThis.crypto.randomUUID();

/**
 * In-memory, transport-independent bridge to authenticated MCP clients.
 * The transport adapter owns delivering frames and calling `respond`.
 */
export const makeInMemoryMcpClientBridge = (
  options: { readonly requestTimeoutMs?: number } = {},
) => {
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const clients = new Map<string, ClientRecord>();
  let latestManifestGeneration = 0;

  const connectionFor = (token: string, record: ClientRecord): McpBridgeConnection => ({
    bindingToken: token,
    manifestGeneration: record.manifestGeneration,
    respond: (id, result, error) => {
      const pending = record.pending.get(id);
      if (!record.active || !pending) return false;
      record.pending.delete(id);
      clearTimeout(pending.timer);
      if (error !== undefined) {
        pending.resume(Effect.fail(new McpClientBridgeError({ reason: "remote", cause: error })));
      } else {
        pending.resume(Effect.succeed(result));
      }
      return true;
    },
    disconnect: () => disconnect(token, record),
  });

  const disconnect = (token: string, record: ClientRecord): void => {
    if (!record.active) return;
    record.active = false;
    clients.delete(token);
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timer);
      pending.resume(Effect.fail(new McpClientBridgeError({ reason: "disconnected" })));
    }
    record.pending.clear();
  };

  const route = (record: ClientRecord, request: McpClientRequest): Promise<unknown> => {
    if (!record.active) {
      return Effect.runPromise(Effect.fail(new McpClientBridgeError({ reason: "disconnected" })));
    }
    const id = opaqueId();
    return Effect.runPromise(
      Effect.callback<unknown, McpClientBridgeError>((resume) => {
        const timer = setTimeout(() => {
          record.pending.delete(id);
          resume(Effect.fail(new McpClientBridgeError({ reason: "timeout" })));
        }, timeoutMs);
        record.pending.set(id, { resume, timer });
        const sent = Effect.runSyncExit(
          Effect.try({
            try: () => record.send({ id, method: request.method, params: request.params }),
            catch: (cause) => new McpClientBridgeError({ reason: "delivery", cause }),
          }),
        );
        if (Exit.isFailure(sent)) {
          clearTimeout(timer);
          record.pending.delete(id);
          resume(Effect.fail(new McpClientBridgeError({ reason: "delivery" })));
        }
        return Effect.sync(() => {
          clearTimeout(timer);
          record.pending.delete(id);
        });
      }),
    );
  };

  return {
    connect(input: {
      readonly principal: Principal;
      readonly send: (frame: McpClientFrame) => void;
      readonly manifest: McpClientManifest;
    }): McpBridgeConnection {
      const token = opaqueId() + opaqueId();
      const record: ClientRecord = {
        principal: input.principal,
        clientIdentity: opaqueId(),
        send: input.send,
        manifest: input.manifest,
        manifestGeneration: ++latestManifestGeneration,
        active: true,
        pending: new Map(),
      };
      clients.set(token, record);
      return connectionFor(token, record);
    },
    authenticate(token: string, principal: Principal): string | null {
      const record = clients.get(token);
      return record?.active && owns(record.principal, principal) ? record.clientIdentity : null;
    },
    /** Resolve the server-owned identity and pinned manifest generation for a binding. */
    getBinding(
      token: string,
      principal: Principal,
    ): { readonly clientIdentity: string; readonly manifestGeneration: number } | null {
      const record = clients.get(token);
      return record?.active && owns(record.principal, principal)
        ? {
            clientIdentity: record.clientIdentity,
            manifestGeneration: record.manifestGeneration,
          }
        : null;
    },
    /**
     * Create a new session generation with the replacement manifest. The
     * existing token and its manifest remain pinned to their original
     * generation; callers must initialize a new MCP session using the returned
     * connection to observe the update. Supply a generation-specific `send`
     * callback when the new transport session uses a different outbound route.
     */
    replaceManifest(
      token: string,
      principal: Principal,
      manifest: McpClientManifest,
      send?: (frame: McpClientFrame) => void,
    ): McpBridgeConnection | null {
      const record = clients.get(token);
      if (!record?.active || !owns(record.principal, principal)) return null;
      const nextToken = opaqueId() + opaqueId();
      const nextRecord: ClientRecord = {
        principal: record.principal,
        clientIdentity: record.clientIdentity,
        send: send ?? record.send,
        manifest,
        manifestGeneration: ++latestManifestGeneration,
        active: true,
        pending: new Map(),
      };
      clients.set(nextToken, nextRecord);
      return connectionFor(nextToken, nextRecord);
    },
    getManifest(token: string, principal: Principal): McpClientManifestSnapshot | null {
      const record = clients.get(token);
      return record?.active && owns(record.principal, principal)
        ? { generation: record.manifestGeneration, manifest: record.manifest }
        : null;
    },
    getManifestForIdentity(
      clientIdentity: string,
      principal: Principal,
      generation: number,
    ): McpClientManifest | null {
      for (const record of clients.values()) {
        if (
          record.active &&
          record.clientIdentity === clientIdentity &&
          record.manifestGeneration === generation &&
          owns(record.principal, principal)
        ) {
          return record.manifest;
        }
      }
      return null;
    },
    /**
     * Pass the generation pinned when the MCP session was initialized. A
     * mismatch fails closed as stale; rebuild the MCP session from its
     * replacement connection rather than changing an existing session in place.
     */
    request(
      token: string,
      principal: Principal,
      request: McpClientRequest,
      expectedManifestGeneration?: number,
    ): Promise<unknown> {
      const record = clients.get(token);
      if (!record?.active || !owns(record.principal, principal)) {
        return Effect.runPromise(
          Effect.fail(new McpClientBridgeError({ reason: "unauthenticated" })),
        );
      }
      if (
        expectedManifestGeneration !== undefined &&
        expectedManifestGeneration !== record.manifestGeneration
      ) {
        return Effect.runPromise(
          Effect.fail(
            new McpClientBridgeError({
              reason: "stale-generation",
              expectedGeneration: expectedManifestGeneration,
              actualGeneration: record.manifestGeneration,
            }),
          ),
        );
      }
      const known =
        request.method === "tools/call"
          ? record.manifest.tools.some((item) => item.name === request.params.name)
          : request.method === "resources/read"
            ? record.manifest.resources.some((item) => item.uri === request.params.uri)
            : record.manifest.prompts.some((item) => item.name === request.params.name);
      if (!known)
        return Effect.runPromise(
          Effect.fail(new McpClientBridgeError({ reason: "capability-not-found" })),
        );
      return route(record, request);
    },
    requestForIdentity(
      clientIdentity: string,
      principal: Principal,
      generation: number,
      request: McpClientRequest,
    ): Promise<unknown> {
      const record = [...clients.values()].find(
        (candidate) =>
          candidate.active &&
          candidate.clientIdentity === clientIdentity &&
          candidate.manifestGeneration === generation &&
          owns(candidate.principal, principal),
      );
      if (!record) {
        return Effect.runPromise(
          Effect.fail(new McpClientBridgeError({ reason: "unauthenticated" })),
        );
      }
      const known =
        request.method === "tools/call"
          ? record.manifest.tools.some((item) => item.name === request.params.name)
          : request.method === "resources/read"
            ? record.manifest.resources.some((item) => item.uri === request.params.uri)
            : record.manifest.prompts.some((item) => item.name === request.params.name);
      if (!known) {
        return Effect.runPromise(
          Effect.fail(new McpClientBridgeError({ reason: "capability-not-found" })),
        );
      }
      return route(record, request);
    },
    disconnect(token: string): void {
      const record = clients.get(token);
      if (record) disconnect(token, record);
    },
    get size(): number {
      return clients.size;
    },
  };
};
