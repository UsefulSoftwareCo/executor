/** Worker service-binding transport for the shared app protocol. */
import type { Fetcher } from "@cloudflare/workers-types";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { Cause, Effect, Queue, Schema, Stream } from "effect";
import { WorkflowFailure, WorkflowRunId } from "apps/contracts";
import { WorkflowBackendState } from "../contracts/workflow-runtime.ts";
import { RuntimeProtocolFailed } from "../contracts/runtime.ts";
import type { WorkerdAppApi } from "../contracts/workerd-host.ts";
import type { BlobStorage } from "../contracts/blobs.ts";
import { connectedWorkerdApps } from "./workerd-client.ts";

const failed = () => new RuntimeProtocolFailed();

/** Connect through a private binding. Authored app Workers never receive this capability. */
export const bindingWorkerdApps = (options: {
  readonly binding: Fetcher;
  readonly authorization: string;
  readonly blobs: BlobStorage;
}) => {
  const headers = { authorization: `Bearer ${options.authorization}` };
  const connect = (path: string) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const response = await options.binding.fetch(`http://apps.internal${path}`, {
            headers: { ...headers, upgrade: "websocket" },
          });
          const socket = response.webSocket;
          if (response.status !== 101 || socket === null) throw new Error("App connection failed");
          socket.accept();
          return socket;
        },
        catch: failed,
      }),
      (socket) => Effect.sync(() => socket.close(1000, "Complete")),
    );
  const rpc = <A, E>(
    work: (api: RpcStub<WorkerdAppApi>, signal: AbortSignal) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifetime = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        );
        const socket = yield* connect("/rpc");
        const peer = yield* Effect.acquireRelease(
          Effect.sync(() => {
            // SAFETY: workerd sockets implement Cap'n Web's EventTarget, send and close
            // transport. Native DOM WebSocket constructor fields are not used here.
            const peer = newWebSocketRpcSession<WorkerdAppApi>(
              socket as unknown as WebSocket,
              undefined,
              { onSendError: () => new Error("App host callback failed") },
            );
            peer.onRpcBroken(() => lifetime.abort());
            return peer;
          }),
          (peer) =>
            Effect.promise(async () => {
              lifetime.abort();
              try {
                await peer.cancel();
              } finally {
                peer[Symbol.dispose]();
              }
            }).pipe(Effect.catchCause(() => Effect.void)),
        );
        return yield* work(peer, lifetime.signal);
      }),
    );
  const changes = (app: string) =>
    Stream.callback<number, RuntimeProtocolFailed>(
      (queue) =>
        Effect.gen(function* () {
          const socket = yield* connect(`/changes?app=${encodeURIComponent(app)}`);
          const changed = (event: { readonly data: string | ArrayBuffer }) => {
            try {
              const { revision } = Schema.decodeUnknownSync(
                Schema.fromJsonString(Schema.Struct({ revision: Schema.Int })),
              )(event.data);
              Queue.offerUnsafe(queue, revision);
            } catch {
              Queue.failCauseUnsafe(queue, Cause.fail(failed()));
            }
          };
          const closed = () => {
            Queue.failCauseUnsafe(queue, Cause.fail(failed()));
          };
          socket.addEventListener("message", changed);
          socket.addEventListener("close", closed);
          socket.addEventListener("error", closed);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              socket.removeEventListener("message", changed);
              socket.removeEventListener("close", closed);
              socket.removeEventListener("error", closed);
            }),
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );
  const backend = (operation: "start" | "status" | "terminate", run: WorkflowRunId) =>
    Effect.tryPromise({
      try: async () => {
        const response = await options.binding.fetch("http://apps.internal/workflow", {
          method: "POST",
          headers,
          body: JSON.stringify({ operation, run }),
        });
        if (response.status !== 200) throw new Error("Workflow request failed");
        return response.json();
      },
      catch: () => new WorkflowFailure({ reason: "engine", retryable: true }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(WorkflowBackendState)),
      Effect.mapError(() => new WorkflowFailure({ reason: "engine", retryable: true })),
    );
  return connectedWorkerdApps(options.blobs, { rpc, changes, backend });
};
