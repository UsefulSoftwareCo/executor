/** Native Alchemy resource; product authorization remains on the calling Worker. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { WorkerLoader } from "@cloudflare/workers-types";
import { Effect, Schema } from "effect";
import {
  makeFacetSupervisor,
  FacetInvocation,
  type FacetBundle,
} from "@executor-js/app-data/cloudflare";

const NativeLoader = Schema.declare(
  (value): value is Pick<WorkerLoader, "get"> =>
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function",
);
type Supervisor = Pick<
  Effect.Success<ReturnType<typeof makeFacetSupervisor>>,
  "invoke" | "cancel" | "cache"
>;
/** One supervisor name is one immutable configured-app ID, across deployments. */
export class AppDataSupervisor extends Cloudflare.DurableObject<AppDataSupervisor, Supervisor>()(
  "AppDataSupervisor",
) {}

/** The API Worker owns the implementation; app-page Workers bind its existing namespace. */
export const AppDataSupervisorLive = AppDataSupervisor.make(
  Effect.gen(function* () {
    // Alchemy provisions the binding. Its current wrapper does not expose getDurableObjectClass.
    yield* Cloudflare.WorkerLoader("AppDataLoader");
    const state = yield* Cloudflare.DurableObjectState;
    const environment = yield* Cloudflare.WorkerEnvironment;
    return Effect.gen(function* () {
      const loader = yield* Schema.decodeUnknownEffect(NativeLoader)(
        environment.AppDataLoader,
      ).pipe(Effect.orDie);
      const supervisor = yield* makeFacetSupervisor(state.raw, loader);
      return {
        cache: supervisor.cache,
        invoke: (
          input: typeof FacetInvocation.Type,
          load: () => Promise<typeof FacetBundle.Type>,
          elicitation: ((input: unknown) => Promise<unknown>) | null = null,
          workflows: ((input: unknown) => Promise<unknown>) | null = null,
        ) => supervisor.invoke(input, load, elicitation, workflows),
        cancel: (id: string) => supervisor.cancel(id),
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          // upgrade already accepts the socket; send the initial revision without accepting twice.
          yield* supervisor.initial(socket.ws).pipe(Effect.orDie);
          return response;
        }),
        alarm: () => supervisor.recover.pipe(Effect.orDie),
        webSocketMessage: () => Effect.void,
        webSocketClose: (socket: Cloudflare.WebSocket) => socket.close(1000, "Closed"),
        webSocketError: (socket: Cloudflare.WebSocket) => socket.close(1011, "Reconnect"),
      };
    });
  }),
);
