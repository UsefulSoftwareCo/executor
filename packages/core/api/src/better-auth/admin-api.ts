import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

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

export const AdminHttpApi = HttpApi.make("executor-self-host-admin").add(AdminApi);
