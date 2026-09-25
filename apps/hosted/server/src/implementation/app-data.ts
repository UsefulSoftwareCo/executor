import { CurrentAuthorization } from "../contracts/authorization.ts";
import { permitsAction, permitsApp } from "@executor-js/authorization";
/** Product-owned authorization around the same SDK data operations used by local. */
import { type AppDataInput } from "@executor-js/sdk/core";
import { Effect, Stream } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest } from "effect/unstable/http";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import {
  OrganizationForbidden,
  CurrentOrganization,
  organizationOwner,
  type OrganizationId,
} from "../contracts/organization.ts";
import { Authentication, ApiAuthentication, Unauthorized } from "../contracts/auth.ts";
import { currentOwner, selectedApp } from "./access.ts";

/** Recheck both login and membership on long-lived streams; initial middleware is not a saved grant. */
const currentAccess = (headers: Headers, organization: OrganizationId, app: AppDataInput["app"]) =>
  Effect.gen(function* () {
    if (headers.has("authorization")) {
      const api = yield* ApiAuthentication;
      const grant = yield* api.authenticate(headers, organization);
      if (
        grant.access.organization !== organization ||
        !permitsAction(grant.policy, "data") ||
        !permitsApp(grant.policy, app)
      )
        return yield* new OrganizationForbidden();
      return grant.access;
    }
    const auth = yield* Authentication;
    const principal = yield* auth.current(headers);
    if (principal === null) return yield* new Unauthorized();
    const membership = yield* auth.membership(principal, organization);
    return { organization, owner: organizationOwner(organization), role: membership.role };
  });
/** Check app ownership and selected accounts before invoking author code. */
export const executeAppData = (kind: "query" | "mutate", input: AppDataInput) =>
  Effect.gen(function* () {
    const policy = yield* CurrentAuthorization;
    if (!permitsAction(policy, "data") || !permitsApp(policy, input.app))
      return yield* new OrganizationForbidden();
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* selectedApp(executor, owner, input.app, input.profile);
    return yield* executor.appData[kind](input);
  });
/** Shared routes; the host supplies request-owned SDK and authentication services. */
export const hostedAppDataHandlers = HttpApiBuilder.group(HostedApi, "appData", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Authentication;
    const api = yield* ApiAuthentication;
    return handlers
      .handle("query", ({ params, payload }) =>
        executeAppData("query", { app: params.app, ...payload }),
      )
      .handle("mutate", ({ params, payload }) =>
        executeAppData("mutate", { app: params.app, ...payload }),
      )
      .handle("subscribe", ({ params, payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const headers = new Headers(request.headers);
          const owner = yield* currentOwner;
          const executor = yield* Effect.flatten(HostedExecutor);
          yield* selectedApp(executor, owner, params.app, payload.profile);
          const access = currentAccess(
            headers,
            (yield* CurrentOrganization).organization,
            params.app,
          ).pipe(
            Effect.provideService(Authentication, auth),
            Effect.provideService(ApiAuthentication, api),
            Effect.tap((access) =>
              selectedApp(executor, access.owner, params.app, payload.profile),
            ),
          );
          const context = yield* Effect.context<Effect.Services<typeof access>>();
          const authorized = access.pipe(Effect.provideContext(context));
          const source = yield* executor.appData.subscribe({ app: params.app, ...payload });
          return Stream.merge(
            source.pipe(Stream.mapEffect((snapshot) => authorized.pipe(Effect.as(snapshot)))),
            Stream.tick("5 seconds").pipe(
              Stream.mapEffect(() => authorized),
              Stream.drain,
            ),
          );
        }),
      );
  }),
);
