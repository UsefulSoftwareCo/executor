import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { OAuthClientSlug, createExecutor, type Executor } from "@executor-js/sdk";
import {
  makeTestConfig,
  memoryCredentialsPlugin,
  serveOAuthTestServer,
  type OAuthTestServerShape,
} from "@executor-js/sdk/testing";

import { ExecutorApi } from "../api";
import { observabilityMiddleware } from "../observability";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "../server";

// ---------------------------------------------------------------------------
// The work-identity HTTP surface — the four routes a console drives to acquire
// the enterprise assertion an enterprise-managed connect presents.
//
// The link flow's own behavior (which token is taken into custody, what a
// rejection means, how a re-link revives connections) is proven in the SDK's
// `oauth-work-identity.test.ts` against the identity provider's ledger. What
// this file proves is the EDGE on top of it:
//
//   - the wire shapes and status codes the contract promises,
//   - that the status projection is safe to hand a browser: no field anywhere in
//     it can carry, or help reconstruct, the held credential,
//   - and that the routing fields round-trip through query params and payloads.
// ---------------------------------------------------------------------------

const IDP_CLIENT = OAuthClientSlug.make("enterprise-idp");
const IDP_CLIENT_ID = "client-at-idp";

/** Every shape a held subject token could travel in. NONE of these keys may
 *  appear in a work-identity HTTP response: the status is a browser-facing
 *  projection of a credential record, and the one thing it must never carry is
 *  the credential. Enumerated so a future field addition has to argue with it. */
const FORBIDDEN_FIELDS = [
  "token",
  "subjectToken",
  "subject_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "accessToken",
  "access_token",
  "clientSecret",
  "client_secret",
  "secret",
] as const;

const assertNoCredentialFields = (body: unknown, where: string): void => {
  const serialized = JSON.stringify(body);
  for (const field of FORBIDDEN_FIELDS) {
    expect(serialized, `${where} must not carry ${field}`).not.toContain(`"${field}"`);
  }
};

const webHandlerFor = (executor: Executor) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(ExecutorApi).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(observabilityMiddleware(ExecutorApi)),
          Layer.provide(Layer.succeed(ExecutorService)(executor)),
          Layer.provide(
            Layer.succeed(ExecutionEngineService)({} as ExecutionEngineService["Service"]),
          ),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const handlerContextFor = (executor: Executor) =>
  Context.make(ExecutorService, executor).pipe(
    Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
  );

type Caller = {
  readonly json: (
    method: "POST" | "DELETE",
    path: string,
    payload: unknown,
  ) => Effect.Effect<{ readonly status: number; readonly body: unknown }>;
  readonly get: (
    path: string,
  ) => Effect.Effect<{ readonly status: number; readonly body: unknown }>;
};

const callerFor = (executor: Executor) =>
  Effect.gen(function* () {
    const web = yield* webHandlerFor(executor);
    const context = handlerContextFor(executor);
    const send = (request: Request) =>
      Effect.promise(async () => {
        const response = await web.handler(request, context);
        return { status: response.status, body: (await response.json()) as unknown };
      });
    return {
      json: (method, path, payload) =>
        send(
          new Request(`http://localhost${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        ),
      get: (path) => send(new Request(`http://localhost${path}`)),
    } satisfies Caller;
  });

/** An identity provider plus a registered app pointing at it, which is the only
 *  setup a link needs — no integration, no connection, no MCP server. */
const enterpriseIdp = () =>
  Effect.gen(function* () {
    const idp = yield* serveOAuthTestServer({
      clients: { [IDP_CLIENT_ID]: null },
      idTokenClaims: { sub: "00u-enterprise-1", email: "alice@enterprise.test" },
      enterpriseIdp: {},
    });
    const executor = yield* createExecutor(
      makeTestConfig({ plugins: [memoryCredentialsPlugin()] as const }),
    );
    yield* executor.oauth.createClient({
      owner: "org",
      slug: IDP_CLIENT,
      authorizationUrl: idp.authorizationEndpoint,
      tokenUrl: idp.tokenEndpoint,
      grant: "authorization_code",
      clientId: IDP_CLIENT_ID,
      clientSecret: "",
    });
    return { idp, executor, caller: yield* callerFor(executor) };
  });

const REF = { owner: "org", idpClient: String(IDP_CLIENT), idpClientOwner: "org" } as const;
const STATUS_QUERY = `/oauth/work-identity/status?owner=${REF.owner}&idpClient=${encodeURIComponent(
  REF.idpClient,
)}&idpClientOwner=${REF.idpClientOwner}`;

interface StartBody {
  readonly authorizationUrl: string;
  readonly state: string;
}
interface StatusBody {
  readonly status: string;
  readonly label?: string | null;
  readonly subject?: string | null;
  readonly subjectTokenType?: string;
  readonly idpClient?: string;
}

const linkThroughHttp = (setup: { readonly idp: OAuthTestServerShape; readonly caller: Caller }) =>
  Effect.gen(function* () {
    const started = yield* setup.caller.json("POST", "/oauth/work-identity/start", REF);
    expect(started.status, "starting a link is a plain 200 with somewhere to send the user").toBe(
      200,
    );
    const start = started.body as StartBody;
    const callback = yield* setup.idp.completeAuthorizationCodeFlow({
      authorizationUrl: start.authorizationUrl,
    });
    return yield* setup.caller.json("POST", "/oauth/work-identity/complete", {
      state: start.state,
      code: callback.code,
    });
  });

describe("work identity HTTP surface", () => {
  it.effect("links, reports the account, and forgets it again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const setup = yield* enterpriseIdp();

        const before = yield* setup.caller.get(STATUS_QUERY);
        expect(before.status).toBe(200);
        expect((before.body as StatusBody).status, "nothing is held before the link").toBe(
          "unlinked",
        );

        const completed = yield* linkThroughHttp(setup);
        expect(completed.status).toBe(200);
        const linked = completed.body as StatusBody;
        expect(linked.status).toBe("linked");
        expect(
          linked.label,
          "the console shows WHICH enterprise account is linked, so the completion already carries it",
        ).toBe("alice@enterprise.test");
        expect(linked.subject).toBe("00u-enterprise-1");
        expect(
          linked.subjectTokenType,
          "and which custody was taken, so a product can warn about the expiring one",
        ).toBe("urn:ietf:params:oauth:token-type:refresh_token");
        assertNoCredentialFields(completed.body, "the link completion response");

        const after = yield* setup.caller.get(STATUS_QUERY);
        expect(
          (after.body as StatusBody).status,
          "the poll a console runs sees the same thing the completion returned",
        ).toBe("linked");
        expect((after.body as StatusBody).idpClient, "keyed by the app it was linked at").toBe(
          REF.idpClient,
        );
        assertNoCredentialFields(after.body, "the status response");

        const unlinked = yield* setup.caller.json("DELETE", "/oauth/work-identity", REF);
        expect(unlinked.status).toBe(200);
        expect(unlinked.body).toEqual({ unlinked: true });
        expect((yield* setup.caller.get(STATUS_QUERY)).body).toMatchObject({ status: "unlinked" });
      }),
    ),
  );

  it.effect("reports an unknown identity provider app as a link failure, not a server error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const setup = yield* enterpriseIdp();

        const failed = yield* setup.caller.json("POST", "/oauth/work-identity/start", {
          ...REF,
          idpClient: "no-such-app",
        });

        expect(
          failed.status,
          "naming an app that does not exist is the caller's mistake and is answerable",
        ).toBe(400);
        expect(failed.body).toMatchObject({ _tag: "WorkIdentityLinkError" });
      }),
    ),
  );

  it.effect("rejects a completion whose state was never issued", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const setup = yield* enterpriseIdp();

        const failed = yield* setup.caller.json("POST", "/oauth/work-identity/complete", {
          state: "not-a-real-state",
          code: "irrelevant",
        });

        expect(failed.status).toBe(404);
        expect(failed.body).toMatchObject({ _tag: "OAuthSessionNotFoundError" });
      }),
    ),
  );
});
