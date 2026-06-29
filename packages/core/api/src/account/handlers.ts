import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest } from "effect/unstable/http";
import { Effect } from "effect";

import { AccountHttpApi } from "./api";
import { AccountProvider, type AccountHeaders } from "./service";

// ---------------------------------------------------------------------------
// Shared, provider-neutral handlers for the Account API. They do nothing but
// read the request headers and delegate to the injected `AccountProvider`, so
// both cloud and self-host serve identical routes — only the service impl
// differs. The neutral errors thrown by the service map directly to their HTTP
// statuses (401/403/500) via the contract annotations.
// ---------------------------------------------------------------------------

const requestHeaders = Effect.map(
  HttpServerRequest.HttpServerRequest.asEffect(),
  (req): AccountHeaders => ({ ...req.headers }),
);

export const AccountHandlers = HttpApiBuilder.group(AccountHttpApi, "account", (handlers) =>
  handlers
    .handle("me", () =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).me(headers);
      }),
    )
    .handle("listApiKeys", () =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).listApiKeys(headers);
      }),
    )
    .handle("createApiKey", ({ payload }) =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).createApiKey(headers, payload.name);
      }),
    )
    .handle("revokeApiKey", ({ params }) =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).revokeApiKey(headers, params.apiKeyId);
      }),
    )
    .handle("listMembers", () =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).listMembers(headers);
      }),
    )
    .handle("listRoles", () =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).listRoles(headers);
      }),
    )
    .handle("inviteMember", ({ payload }) =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).inviteMember(headers, payload);
      }),
    )
    .handle("removeMember", ({ params }) =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).removeMember(headers, params.membershipId);
      }),
    )
    .handle("updateMemberRole", ({ params, payload }) =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).updateMemberRole(
          headers,
          params.membershipId,
          payload.roleSlug,
        );
      }),
    )
    .handle("updateOrgName", ({ payload }) =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).updateOrgName(headers, payload.name);
      }),
    ),
);
