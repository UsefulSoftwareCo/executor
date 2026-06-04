import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Self-host admin API — the invite-code surface (app-local, self-host only).
//
// Member/role management is the shared, provider-neutral /account/* surface
// (served by the Better Auth AccountProvider, rendered by the shared org page).
// Invite CODES are self-host's join mechanism and have no neutral equivalent —
// cloud joins via WorkOS — so they live in this app-local group, served
// alongside the core API under /api and consumed by a self-host atom client.
//
// Browser-safe: schemas + the HttpApi value only (no server imports), so the
// web client can build a typed AtomHttpApi from it.
// ---------------------------------------------------------------------------

export class AdminError extends Schema.TaggedErrorClass<AdminError>()(
  "AdminError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

export class AdminUnauthorized extends Schema.TaggedErrorClass<AdminUnauthorized>()(
  "AdminUnauthorized",
  {},
  { httpApiStatus: 401 },
) {}

export class AdminForbidden extends Schema.TaggedErrorClass<AdminForbidden>()(
  "AdminForbidden",
  {},
  { httpApiStatus: 403 },
) {}

export const InviteCode = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  role: Schema.String,
  label: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  usedByEmail: Schema.NullOr(Schema.String),
  usedAt: Schema.NullOr(Schema.String),
});

export const InvitesResponse = Schema.Struct({
  invites: Schema.Array(InviteCode),
});

export const CreateInviteBody = Schema.Struct({
  role: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  expiresInDays: Schema.optional(Schema.NullOr(Schema.Number)),
});

export const SuccessResponse = Schema.Struct({
  success: Schema.Boolean,
});

const InviteParams = { inviteId: Schema.String };

// Paths are `/admin/*` (no `/api`): the server mounts this on the same
// `/api`-prefixed router as the core API, and the client prepends the `/api`
// base — symmetric with the account API.
export const AdminApi = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("listInvites", "/admin/invites", {
      success: InvitesResponse,
      error: [AdminError, AdminUnauthorized, AdminForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.post("createInvite", "/admin/invites", {
      payload: CreateInviteBody,
      success: InviteCode,
      error: [AdminError, AdminUnauthorized, AdminForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.delete("revokeInvite", "/admin/invites/:inviteId", {
      params: InviteParams,
      success: SuccessResponse,
      error: [AdminError, AdminUnauthorized, AdminForbidden],
    }),
  );

/**
 * Standalone HttpApi wrapping the admin group — used to build the self-host
 * `AdminApiClient` atoms in the web app, and mounted server-side as an
 * extension route layer.
 */
export const AdminHttpApi = HttpApi.make("executor-self-host-admin").add(AdminApi);
