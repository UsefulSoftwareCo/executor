// ---------------------------------------------------------------------------
// AdminUsersProvider — the provider seam behind the neutral Admin Users API.
//
// The shared `AdminUsersHandlers` are generic: they read the request headers,
// authorize through this service, and project the SDK's platform view onto the
// wire shapes. Each host implements the AUTHORIZATION half differently:
//   - cloud      → an org-scoped API key (PlatformAuth) OR an admin session member
//   - self-host  → a Better Auth owner/admin member of the single org
// while the READ half is identical everywhere (`executor.admin`).
//
// This mirrors `AccountProvider`: one set of handlers, one contract, per-host
// implementations. Methods take the raw request headers (cookie / bearer) so
// the implementation can resolve and authorize the caller itself — the admin
// plane is NOT behind the execution-stack middleware, because that middleware
// binds a product-view executor to one acting subject and the admin plane needs
// a subject-less, tenant-reach one.
// ---------------------------------------------------------------------------

import { Context, type Effect } from "effect";
import {
  type AdminUserNotFound,
  type AdminUsersError,
  type AdminUsersForbidden,
  type AdminUsersUnauthorized,
  AdminUserResponse,
  AdminUsersResponse,
  AdminUserConnectionsResponse,
  AdminUsersWithConnectionsResponse,
} from "./api";

export type AdminUsersHeaders = Record<string, string>;

/** Paging and filtering, mirroring the SDK's `AdminListSubjectsOptions` plus
 *  the contract's `?email=`. The email arrives already trimmed and lower-cased
 *  by the contract schema, so a provider never re-normalizes it. */
export interface AdminUsersListOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly email?: string;
}

type User = typeof AdminUserResponse.Type;
type Users = typeof AdminUsersResponse.Type;
type UserConnections = typeof AdminUserConnectionsResponse.Type;
type UsersWithConnections = typeof AdminUsersWithConnectionsResponse.Type;

/** Every admin read: authorized, and failing with the neutral triple. */
type Authorized<A> = Effect.Effect<
  A,
  AdminUsersError | AdminUsersUnauthorized | AdminUsersForbidden
>;

export interface AdminUsersProviderShape {
  readonly listUsers: (
    headers: AdminUsersHeaders,
    options: AdminUsersListOptions,
  ) => Authorized<Users>;
  readonly listUsersWithConnections: (
    headers: AdminUsersHeaders,
    options: AdminUsersListOptions,
  ) => Authorized<UsersWithConnections>;
  readonly listUserConnections: (
    headers: AdminUsersHeaders,
    externalId: string,
  ) => Authorized<UserConnections>;
  /** One user by `externalId` or email. Adds 404 to the neutral triple — the
   *  only read here that can honestly say "no such user of yours". */
  readonly getUser: (
    headers: AdminUsersHeaders,
    identifier: string,
  ) => Effect.Effect<
    User,
    AdminUsersError | AdminUsersUnauthorized | AdminUsersForbidden | AdminUserNotFound
  >;
}

export class AdminUsersProvider extends Context.Service<
  AdminUsersProvider,
  AdminUsersProviderShape
>()("@executor-js/api/AdminUsersProvider") {}
