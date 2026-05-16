import { requestHandler } from "@tanstack/react-start/server";
import { Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiClient } from "effect/unstable/httpapi";

import {
  AutumnTestLayer,
  makeAutumnTestState,
  type AutumnTestState,
} from "../services/autumn.test-layer";
import { ApiKeyServiceTestLayer } from "./api-keys.test-layer";
import {
  makeUserStoreTestState,
  UserStoreTestLayer,
  type UserStoreTestState,
} from "./context.test-layer";
import { CloudAuthPublicHandlers, CloudSessionAuthHandlers, NonProtectedApi } from "./handlers";
import {
  makeSessionTestContext,
  SessionAuthTestLayer,
  type SessionTestContext,
} from "./middleware.test-layer";
import { makeWorkOSTestState, WorkOSTestLayer, type WorkOSTestState } from "./workos.test-layer";

const TEST_BASE_URL = "http://test.local";
const SESSION_COOKIE = "wos-session=test_session";

export type CloudAuthApiTestState = {
  readonly workos: WorkOSTestState;
  readonly autumn: AutumnTestState;
  readonly userStore: UserStoreTestState;
  readonly session: SessionTestContext;
};

export const makeCloudAuthApiTestState = (
  overrides: Partial<CloudAuthApiTestState> = {},
): CloudAuthApiTestState => ({
  workos: makeWorkOSTestState(),
  autumn: makeAutumnTestState(),
  userStore: makeUserStoreTestState(),
  session: makeSessionTestContext(),
  ...overrides,
});

const makeCloudAuthApiTestClient = (state: CloudAuthApiTestState) => {
  const ApiLive = HttpApiBuilder.layer(NonProtectedApi).pipe(
    Layer.provide(Layer.mergeAll(CloudAuthPublicHandlers, CloudSessionAuthHandlers)),
    Layer.provide(SessionAuthTestLayer(state.session)),
    Layer.provideMerge(WorkOSTestLayer(state.workos)),
    Layer.provideMerge(AutumnTestLayer(state.autumn)),
    Layer.provideMerge(UserStoreTestLayer(state.userStore)),
    Layer.provideMerge(ApiKeyServiceTestLayer),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
  );

  const handler = HttpRouter.toWebHandler(ApiLive, { disableLogger: true }).handler;
  const startHandler = requestHandler((request) => handler(request, undefined));
  const fetchViaHandler: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    request.headers.set("cookie", SESSION_COOKIE);
    return await startHandler(request, undefined);
  };
  const clientLayer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetchViaHandler)),
  );

  return HttpApiClient.make(NonProtectedApi, { baseUrl: TEST_BASE_URL }).pipe(
    Effect.provide(clientLayer),
  );
};

export type CloudAuthApiTestClient = Effect.Success<ReturnType<typeof makeCloudAuthApiTestClient>>;

export class CloudAuthApiTestContext extends Context.Service<
  CloudAuthApiTestContext,
  {
    readonly state: CloudAuthApiTestState;
    readonly client: CloudAuthApiTestClient;
  }
>()("CloudAuthApiTestContext") {}

export const CloudAuthApiTestContextLayer = (state = makeCloudAuthApiTestState()) =>
  Layer.effect(
    CloudAuthApiTestContext,
    Effect.gen(function* () {
      const client = yield* makeCloudAuthApiTestClient(state);
      return { state, client };
    }),
  );
