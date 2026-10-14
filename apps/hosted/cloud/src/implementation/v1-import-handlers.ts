import { CurrentPrincipal, HostedExecutor, McpAuthentication } from "@executor-js/hosted-server";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ExecutorCloudApi } from "../contracts/api.ts";
import { V1Import, V1ImportDatabase, V1ImportUnavailable } from "../contracts/v1-import.ts";

/** Cookie-authenticated import requests; the acting user always comes from the session. */
export const v1ImportHandlers = HttpApiBuilder.group(ExecutorCloudApi, "v1Import", (handlers) =>
  Effect.gen(function* () {
    const v1 = yield* V1Import;
    const auth = yield* McpAuthentication;
    const request = Effect.gen(function* () {
      const executor = yield* Effect.flatten(HostedExecutor);
      const sql = yield* Effect.flatten(V1ImportDatabase);
      return {
        executor,
        connections: auth.connections,
        sql,
        user: (yield* CurrentPrincipal).userId,
      };
    }).pipe(Effect.mapError(() => new V1ImportUnavailable()));
    return handlers
      .handle("choices", () => request.pipe(Effect.flatMap(v1.choices)))
      .handle("preview", ({ params }) =>
        request.pipe(Effect.flatMap((current) => v1.preview(current, params.organization))),
      )
      .handle("start", ({ params, payload }) =>
        request.pipe(Effect.flatMap((current) => v1.start(current, params.organization, payload))),
      )
      .handle("item", ({ params }) =>
        request.pipe(
          Effect.flatMap((current) =>
            v1.item(current, params.organization, { kind: params.kind, id: params.id }),
          ),
        ),
      )
      .handle("finish", ({ params }) =>
        request.pipe(Effect.flatMap((current) => v1.finish(current, params.organization))),
      );
  }),
);
