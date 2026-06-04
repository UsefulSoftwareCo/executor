import { Effect, Layer } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient } from "effect/unstable/http";

import { AdminHttpApi } from "../admin/api";
import { type InviteRole } from "../auth/invites";

// Test helper: mint an invite code through the TYPED admin HttpApi client, the
// same surface the web app calls — no raw request building, no direct DB poke.
// The one unavoidable raw call is the bootstrap admin's Better Auth sign-in (an
// auth boundary, not an HttpApi surface); everything after is the typed client.

type Handler = (request: Request) => Promise<Response>;

const BASE = "http://localhost:4788/api";

const signInToken = async (handler: Handler, email: string, password: string): Promise<string> => {
  const response = await handler(
    new Request("http://localhost:4788/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  return response.headers.get("set-auth-token") ?? "";
};

// A FetchHttpClient backed by the in-process handler, carrying the admin bearer.
const clientLayer = (handler: Handler, token: string) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch)(((input: RequestInfo | URL, init?: RequestInit) => {
        const base = input instanceof Request ? input : new Request(input, init);
        const request = new Request(base, {
          headers: { ...Object.fromEntries(base.headers), authorization: `Bearer ${token}` },
        });
        return handler(request);
      }) as typeof globalThis.fetch),
    ),
  );

export const mintInviteCode = async (
  handler: Handler,
  role: InviteRole = "member",
): Promise<string> => {
  const token = await signInToken(
    handler,
    process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL!,
    process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD!,
  );
  return Effect.gen(function* () {
    const client = yield* HttpApiClient.make(AdminHttpApi, { baseUrl: BASE });
    const invite = yield* client.admin.createInvite({ payload: { role } });
    return invite.code;
  }).pipe(Effect.provide(clientLayer(handler, token)), Effect.runPromise);
};
