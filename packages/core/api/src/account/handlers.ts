import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest } from "effect/unstable/http";
import { Effect } from "effect";

import { AccountError, AccountHttpApi } from "./api";
import {
  AccountProvider,
  DelegationProvider,
  type AccountHeaders,
  type DelegationRequestContext,
} from "./service";

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

const delegationRequest = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  // The incoming Request URL is the authority the server actually received.
  // Never copy the caller-controlled Origin header into this field: doing so
  // would let a forged Origin equal the comparison value when a host has no
  // configured public origin. The browser Origin remains separate so hosts can
  // enforce same-origin CSRF checks.
  const webRequest = yield* HttpServerRequest.toWeb(req).pipe(
    Effect.mapError(() => new AccountError({ message: "Failed to read request origin." })),
  );
  return {
    headers: { ...req.headers },
    requestOrigin: new URL(webRequest.url).origin,
    browserOrigin: req.headers.origin ?? null,
    method: req.method,
  } satisfies DelegationRequestContext;
});

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
    .handle("listOrgApiKeys", () =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).listOrgApiKeys(headers);
      }),
    )
    .handle("createOrgApiKey", ({ payload }) =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).createOrgApiKey(headers, payload.name);
      }),
    )
    .handle("revokeOrgApiKey", ({ params }) =>
      Effect.gen(function* () {
        const headers = yield* requestHeaders;
        return yield* (yield* AccountProvider).revokeOrgApiKey(headers, params.apiKeyId);
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
    )
    .handle("listDelegatedCredentials", ({ query }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).listDelegatedCredentials(request, query);
      }),
    )
    .handle("listDelegationTargets", () =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).listDelegationTargets(request);
      }),
    )
    .handle("listDelegationScopeOptions", ({ query }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).listDelegationScopeOptions(request, query);
      }),
    )
    .handle("listDelegationNotifications", () =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).listDelegationNotifications(request);
      }),
    )
    .handle("markDelegationNotificationRead", ({ params }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).markDelegationNotificationRead(
          request,
          params.notificationId,
        );
      }),
    )
    .handle("createDelegatedKey", ({ payload }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).createDelegatedKey(request, payload);
      }),
    )
    .handle("startDelegationChallenge", ({ payload }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).startDelegationChallenge(request, payload);
      }),
    )
    .handle("getDelegationChallenge", ({ params }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).getDelegationChallenge(
          request,
          params.challengeId,
        );
      }),
    )
    .handle("completeDelegationProof", ({ params, payload }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).completeDelegationProof(
          request,
          params.challengeId,
          payload,
        );
      }),
    )
    .handle("consentDelegationChallenge", ({ params, payload }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).consentDelegationChallenge(
          request,
          params.challengeId,
          payload,
        );
      }),
    )
    .handle("consentDelegatedCredential", ({ params, payload }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).consentDelegatedCredential(
          request,
          params.credentialId,
          payload,
        );
      }),
    )
    .handle("rotateDelegatedKey", ({ params }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).rotateDelegatedKey(request, params.credentialId);
      }),
    )
    .handle("revokeDelegatedCredential", ({ params }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).revokeDelegatedCredential(
          request,
          params.credentialId,
        );
      }),
    )
    .handle("revokeAllDelegatedCredentials", ({ payload }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).revokeAllDelegatedCredentials(request, payload);
      }),
    )
    .handle("listDelegationAudit", ({ query }) =>
      Effect.gen(function* () {
        const request = yield* delegationRequest;
        return yield* (yield* DelegationProvider).listDelegationAudit(request, query);
      }),
    ),
);
