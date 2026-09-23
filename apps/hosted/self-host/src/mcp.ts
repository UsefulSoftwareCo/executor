/** Docker keeps protocol state in bounded, idle-expiring Effect scopes. */
import {
  authenticatedMcp,
  browserMcpRequest,
  hostedMcpApproval,
  dispatchHostedMcp,
  makeHostedMcp,
  mcpSessionKey,
} from "@executor-js/hosted-server";
import { Effect, RcMap } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

/** Own protocol sessions in the server scope; the returned handler receives SDK/auth per request. */
export const selfHostMcp = Effect.gen(function* () {
  const sessions = yield* RcMap.make({
    lookup: (_key: string) => makeHostedMcp(),
    idleTimeToLive: "30 minutes",
    capacity: 256,
  });
  const http = authenticatedMcp((access) =>
    Effect.gen(function* () {
      const handler = yield* RcMap.get(sessions, mcpSessionKey(access));
      return yield* dispatchHostedMcp(access, handler.http);
    }).pipe(
      Effect.catchTag("ExceededCapacityError", () =>
        Effect.succeed(
          // An active request is never evicted to admit a new session.
          // Native clients can retry after another scope expires.
          HttpServerResponse.empty({ status: 503 }),
        ),
      ),
    ),
  );
  const approvals = browserMcpRequest((access, address) =>
    Effect.gen(function* () {
      const host = yield* RcMap.get(sessions, mcpSessionKey(access));
      return yield* hostedMcpApproval(host.approvals, access, address);
    }).pipe(
      Effect.catchTag("ExceededCapacityError", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      ),
    ),
  );
  return { http, approvals };
});
