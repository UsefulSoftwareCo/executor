import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest } from "effect/unstable/http";
import { Effect } from "effect";
import type {
  AdminListAuditEventsOptions,
  AuditEventAction,
  AuditResourceType,
  Owner,
} from "@executor-js/sdk";

import { AdminUsersHttpApi } from "./api";
import { normalizeEmail } from "./reads";
import { AdminUsersProvider, type AdminUsersHeaders, type AdminUsersListOptions } from "./service";

// ---------------------------------------------------------------------------
// Shared, provider-neutral handlers for the Admin Users API. They do nothing
// but read the request headers + paging and delegate to the injected
// `AdminUsersProvider`, so cloud and self-host serve identical routes — only
// the authorization impl differs. The neutral errors map to their HTTP statuses
// (401/403/500) via the contract annotations.
// ---------------------------------------------------------------------------

const requestHeaders = Effect.map(
  HttpServerRequest.HttpServerRequest.asEffect(),
  (request): AdminUsersHeaders => ({ ...request.headers }),
);

// The contract decodes `limit`/`offset` to numbers, but leaves them optional.
// Spread only the keys that are present so the SDK's own defaults apply rather
// than an explicit `undefined` overriding them.
// `email` is normalized here rather than in the contract schema, so the filter
// and the single-user path parameter share ONE rule (`normalizeEmail`).
const listOptions = (query: {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly email?: string | undefined;
}): AdminUsersListOptions => ({
  ...(query.limit === undefined ? {} : { limit: query.limit }),
  ...(query.offset === undefined ? {} : { offset: query.offset }),
  ...(query.email === undefined ? {} : { email: normalizeEmail(query.email) }),
});

const auditListOptions = (query: {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly actorId?: string | undefined;
  readonly action?: AuditEventAction | undefined;
  readonly resourceType?: AuditResourceType | undefined;
  readonly resourceOwner?: Owner | undefined;
}): AdminListAuditEventsOptions => ({
  ...(query.limit === undefined ? {} : { limit: query.limit }),
  ...(query.offset === undefined ? {} : { offset: query.offset }),
  ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
  ...(query.action === undefined ? {} : { action: query.action }),
  ...(query.resourceType === undefined ? {} : { resourceType: query.resourceType }),
  ...(query.resourceOwner === undefined ? {} : { resourceOwner: query.resourceOwner }),
});

export const AdminUsersHandlers = HttpApiBuilder.group(
  AdminUsersHttpApi,
  "adminUsers",
  (handlers) =>
    handlers
      .handle("listAuditEvents", ({ query }) =>
        Effect.gen(function* () {
          const headers = yield* requestHeaders;
          return yield* (yield* AdminUsersProvider).listAuditEvents(
            headers,
            auditListOptions(query),
          );
        }),
      )
      .handle("listUsers", ({ query }) =>
        Effect.gen(function* () {
          const headers = yield* requestHeaders;
          return yield* (yield* AdminUsersProvider).listUsers(headers, listOptions(query));
        }),
      )
      .handle("listUsersWithConnections", ({ query }) =>
        Effect.gen(function* () {
          const headers = yield* requestHeaders;
          return yield* (yield* AdminUsersProvider).listUsersWithConnections(
            headers,
            listOptions(query),
          );
        }),
      )
      .handle("listUserConnections", ({ params }) =>
        Effect.gen(function* () {
          const headers = yield* requestHeaders;
          return yield* (yield* AdminUsersProvider).listUserConnections(headers, params.externalId);
        }),
      )
      .handle("getUser", ({ params }) =>
        Effect.gen(function* () {
          const headers = yield* requestHeaders;
          return yield* (yield* AdminUsersProvider).getUser(headers, params.identifier);
        }),
      ),
);
