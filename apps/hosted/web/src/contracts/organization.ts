import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { pollingQuery } from "@executor-js/ui/contracts/polling";
import { observeBrowserUsage } from "./product-analytics.ts";
import { protectedQuery } from "./protected-query.ts";
import { hydratedResult } from "@executor-js/ui/contracts/http";
import {
  organizationTargetAtom,
  organizationPresentationAtom,
  organizationAccessVersionAtom,
} from "./organization-reference.ts";
import { OrganizationReference, OrganizationSlug } from "@executor-js/hosted-server/organization";
import { BrowserAtoms } from "./telemetry.ts";
import { UploadedOrganizationIcon } from "@executor-js/hosted-server/organization-icon";
import { OrganizationAccess, OrganizationForbidden } from "@executor-js/hosted-server/organization";
import { OrganizationId } from "@executor-js/hosted-server/organization";
import { Effect, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  authCallOptions,
  organizationOperations,
  sessionAtom,
  type AuthCallOptions,
} from "./auth.ts";
import { HostedClient } from "./api.ts";
import {
  acknowledge,
  acknowledgedQuery,
  upsert,
  currentQuery,
} from "@executor-js/ui/contracts/mutations";

/** Safe organization errors; raw auth errors are not rendered. */
export class OrganizationFailed extends Schema.TaggedError<OrganizationFailed>()(
  "OrganizationFailed",
  { message: Schema.String },
) {}
const request = <A>(
  operation: string,
  run: (
    options: AuthCallOptions,
  ) => Promise<
    { data: A; error: null } | { data: null; error: { status: number; code?: string | undefined } }
  >,
) =>
  Effect.flatMap(authCallOptions, (options) =>
    Effect.tryPromise({
      try: () => run(options),
      catch: () => new OrganizationFailed({ message: "Cannot reach the server. Try again." }),
    }),
  ).pipe(
    Effect.flatMap((result) =>
      result.error === null
        ? Effect.succeed(result.data)
        : Effect.fail(
            new OrganizationFailed({
              message:
                result.error.code === "ORGANIZATION_SLUG_ALREADY_TAKEN" ||
                result.error.code === "ORGANIZATION_ALREADY_EXISTS"
                  ? "This organization URL is already in use. Choose another."
                  : result.error.code === "INVITATION_NOT_FOUND"
                    ? "This invitation has already been used, was revoked, or has expired. Ask an administrator for a new invitation."
                    : result.error.code === "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED"
                      ? "This organization has reached its plan's member limit. An owner or admin can upgrade the plan to add members."
                      : result.error.status === 403
                        ? "You do not have permission to do that."
                        : "Unable to update the organization. Check the details and try again.",
            }),
          ),
    ),
    Effect.flatMap((data) =>
      data === null
        ? Effect.fail(
            new OrganizationFailed({
              message: "The organization is no longer available. Reload and try again.",
            }),
          )
        : Effect.succeed(data),
    ),
    (work) =>
      observeBrowserUsage(
        "organization",
        operation.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        work,
      ),
    Effect.withSpan(`ui.organization.${operation}`),
  );

/** Minimal organization identity used by routes, creation and invitation returns. */
export const OrganizationSummary = Schema.Struct({
  id: OrganizationId,
  name: Schema.String,
  slug: Schema.NonEmptyString,
  logo: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type OrganizationSummary = typeof OrganizationSummary.Type;

/**
 * The signed-in user. A session revalidation that confirms the same person leaves it unchanged, so
 * it does not read the organizations again.
 */
const signedInUser = Atom.map(sessionAtom, (session) =>
  AsyncResult.isSuccess(session) && session.value !== null ? session.value.user.id : null,
);
/**
 * Refresh when the signed-in user changes, including switching users in this browser. Membership
 * changed elsewhere is read again once on every return to the tab, by `revalidated` below.
 */
const organizationsQuery = BrowserAtoms.atom((get) => {
  if (get(signedInUser) === null) return Effect.succeed([]);
  return request("list", (options) => organizationOperations(options).list()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OrganizationSummary))),
  );
}).pipe(
  hydratedResult({
    key: "hosted:organizations",
    success: Schema.Array(OrganizationSummary),
    error: OrganizationFailed,
  }),
);

/** A server-rendered entry document can supply membership before the browser mounts. */
export const entryOrganizationsAtom = Atom.make<Option.Option<ReadonlyArray<OrganizationSummary>>>(
  Option.none(),
).pipe(
  Atom.serializable({
    key: "hosted:entry-organizations",
    schema: Schema.Option(Schema.Array(OrganizationSummary)),
  }),
  Atom.keepAlive,
);
const initialOrganizationsQuery = Atom.readable(
  (get) => {
    const entry = get(entryOrganizationsAtom);
    return Option.isSome(entry)
      ? AsyncResult.success<
          ReadonlyArray<OrganizationSummary>,
          OrganizationFailed | Schema.SchemaError
        >(entry.value)
      : get(organizationsQuery);
  },
  (refresh) => {
    refresh(entryOrganizationsAtom);
    refresh(organizationsQuery);
  },
).pipe(revalidated);
/** Confirmed writes and source waiting state are shared by every route consumer. */
export const organizationsAtom = acknowledgedQuery(initialOrganizationsQuery);

/** Create without changing any session preference; the caller navigates this tab. */
export const createOrganizationAtom = BrowserAtoms.fn(
  (input: { name: string; slug: string }, get) =>
    request("create", (options) => organizationOperations(options).create(input)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OrganizationSummary)),
      Effect.tap((saved) =>
        Effect.sync(() =>
          acknowledge(get, organizationsAtom, (current) => [
            ...current.filter((organization) => organization.id !== saved.id),
            saved,
          ]),
        ),
      ),
    ),
);
/** Query keys include the organization so switching never displays another organization's rows. */
export const accessAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime
    .atom((get) => {
      get(organizationAccessVersionAtom);
      return Effect.flatMap(HostedClient, (client) =>
        client.organization.access({ params: { organization } }),
      ).pipe(
        Effect.tap((access) =>
          Effect.sync(() => {
            get.set(organizationTargetAtom(organization), access.organization);
            get.set(organizationPresentationAtom(access.organization), access);
          }),
        ),
      );
    })
    .pipe(
      hydratedResult({
        key: `hosted:organization-access:${organization}`,
        success: OrganizationAccess,
        error: OrganizationForbidden,
      }),
      revalidated,
      currentQuery,
    ),
);
/** Known presentation follows canonical identity across a successful slug rename. */
export const organizationPresentation = Atom.family((reference: OrganizationReference) =>
  Atom.make((get) => {
    const id = get(organizationTargetAtom(reference));
    return id === undefined ? undefined : get(organizationPresentationAtom(id));
  }),
);
/** Persisted app/account inventory for the current organization. */
export const inventoryAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("organization", "inventory", hydrated({ params: { organization } })).pipe(
    revalidated,
    pollingQuery,
    protectedQuery,
  ),
);
/** The member and invitation fields the settings page shows; Better Auth's responses decode to them. */
const OrganizationMember = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  role: Schema.String,
  user: Schema.Struct({
    name: Schema.String,
    email: Schema.String,
    image: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const OrganizationInvitation = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  role: Schema.String,
  status: Schema.String,
  expiresAt: Schema.Date,
});
const OrganizationMembers = Schema.Struct({
  members: Schema.Array(OrganizationMember),
  invitations: Schema.Array(OrganizationInvitation),
});
/** Follow native pagination so search includes members beyond Better Auth's first page. */
export const membersAtom = Atom.family((organizationId: OrganizationId) =>
  BrowserAtoms.atom((get) => {
    const organization = get(organizationPresentationAtom(organizationId));
    const allMembers = Effect.gen(function* () {
      const first = yield* request("members", (options) =>
        organizationOperations(options).members(organizationId, 0),
      );
      const members = [...first.members];
      while (members.length < first.total) {
        const next = yield* request("members", (options) =>
          organizationOperations(options).members(organizationId, members.length),
        );
        if (next.members.length === 0) break;
        members.push(...next.members);
      }
      return members;
    });
    // Presentation only selects which query to make; the server rechecks the
    // current membership before returning any invitation credentials.
    const invitations =
      organization?.role === "owner" || organization?.role === "admin"
        ? request("invitations", (options) =>
            organizationOperations(options).invitations(organizationId),
          )
        : Effect.succeed([]);
    return Effect.gen(function* () {
      const [members, pending] = yield* Effect.all([allMembers, invitations], {
        concurrency: "unbounded",
      });
      return yield* Schema.decodeUnknownEffect(OrganizationMembers)({
        members,
        invitations: pending,
      }).pipe(
        Effect.mapError(
          () => new OrganizationFailed({ message: "Unable to load members. Try again." }),
        ),
      );
    });
  }).pipe(
    hydratedResult({
      key: `hosted:organization-members:${organizationId}`,
      success: OrganizationMembers,
      error: OrganizationFailed,
    }),
    revalidated,
    acknowledgedQuery,
  ),
);
/** Reuse pending invitations so failed email delivery can be retried safely. */
export const inviteAtom = Atom.family((organizationId: OrganizationId) =>
  BrowserAtoms.fn((input: { email: string; role: "admin" | "member" }, get) =>
    request("invite", (options) =>
      organizationOperations(options).invite({ ...input, organizationId }),
    ).pipe(
      Effect.tap((saved) =>
        Effect.sync(() =>
          acknowledge(get, membersAtom(organizationId), (current) => ({
            ...current,
            invitations: Array.from(upsert(current.invitations, saved)),
          })),
        ),
      ),
    ),
  ),
);
/** Revoke by invitation identity; remove its pending row only after server acknowledgement. */
export const revokeInvitationAtom = Atom.family((organizationId: OrganizationId) =>
  BrowserAtoms.fn((invitationId: string, get) =>
    request("revokeInvitation", (options) =>
      organizationOperations(options).revokeInvitation(invitationId),
    ).pipe(
      Effect.tap((saved) =>
        Effect.sync(() =>
          acknowledge(get, membersAtom(organizationId), (current) => ({
            ...current,
            invitations: current.invitations.filter((invitation) => invitation.id !== saved.id),
          })),
        ),
      ),
      Effect.asVoid,
    ),
  ),
);
/** Remove an existing member; server-side role rules protect the last owner. */
export const removeMemberAtom = Atom.family((organizationId: OrganizationId) =>
  BrowserAtoms.fn((memberIdOrEmail: string, get) =>
    request("removeMember", (options) =>
      organizationOperations(options).removeMember({ organizationId, memberIdOrEmail }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          acknowledge(get, membersAtom(organizationId), (current) => ({
            ...current,
            members: current.members.filter(
              (member) => member.id !== memberIdOrEmail && member.user.email !== memberIdOrEmail,
            ),
          })),
        ),
      ),
      Effect.asVoid,
    ),
  ),
);
/** Rename through the shared list only after the server acknowledges the write. */
export const renameOrganizationAtom = Atom.family((organizationId: OrganizationId) =>
  BrowserAtoms.fn((name: string, get) =>
    request("rename", (options) =>
      organizationOperations(options).rename({ organizationId, name }),
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OrganizationSummary)),
      Effect.tap((saved) =>
        Effect.sync(() =>
          acknowledge(get, organizationsAtom, (current) =>
            current.map((organization) =>
              organization.id === saved.id ? { ...organization, name: saved.name } : organization,
            ),
          ),
        ),
      ),
      Effect.asVoid,
    ),
  ),
);
/** A URL changes only after the server accepts it; collisions keep the current route intact. */
export const changeOrganizationSlugAtom = Atom.family((organizationId: OrganizationId) =>
  BrowserAtoms.fn((slug: string, get) =>
    request("changeSlug", (options) =>
      organizationOperations(options).changeSlug({ organizationId, slug }),
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OrganizationSummary)),
      Effect.tap((saved) =>
        Effect.sync(() => {
          const reference = organizationTargetAtom(OrganizationSlug.make(saved.slug));
          const previous = get.registry.get(reference);
          if (previous === undefined || previous === saved.id) get.set(reference, saved.id);
          acknowledge(get, organizationsAtom, (current) =>
            current.map((organization) =>
              organization.id === saved.id ? { ...organization, slug: saved.slug } : organization,
            ),
          );
        }),
      ),
    ),
  ),
);
/** Persist an explicit icon edit and reconcile all organization readers before completion. */
export const changeOrganizationLogoAtom = Atom.family((organizationId: OrganizationId) =>
  HostedClient.runtime.fn((image: UploadedOrganizationIcon | null, get) =>
    Effect.gen(function* () {
      const client = yield* HostedClient;
      const logo =
        image === null
          ? null
          : (yield* client.organization
              .uploadIcon({ params: { organization: organizationId }, payload: image })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new OrganizationFailed({
                      message: Schema.is(OrganizationForbidden)(error)
                        ? "You do not have permission to change this icon."
                        : "Unable to upload the icon. Try again.",
                    }),
                ),
              )).logo;
      const saved = yield* request("changeLogo", (options) =>
        organizationOperations(options).changeLogo({ organizationId, logo }),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrganizationSummary)));
      acknowledge(get, organizationsAtom, (current) =>
        current.map((organization) => (organization.id === saved.id ? saved : organization)),
      );
      return saved;
    }),
  ),
);
/** Better Auth checks role authority; refresh this tab's access after self-demotion. */
export const updateMemberRoleAtom = Atom.family((organizationId: OrganizationId) =>
  BrowserAtoms.fn((input: { memberId: string; role: "admin" | "member" }, get) =>
    request("updateMemberRole", (options) =>
      organizationOperations(options).updateMemberRole({ ...input, organizationId }),
    ).pipe(
      Effect.tap((saved) =>
        Effect.sync(() => {
          acknowledge(get, membersAtom(organizationId), (current) => ({
            ...current,
            members: current.members.map((member) =>
              member.id === input.memberId ? { ...member, role: saved.role } : member,
            ),
          }));
          get.set(
            organizationAccessVersionAtom,
            get.registry.get(organizationAccessVersionAtom) + 1,
          );
        }),
      ),
      Effect.asVoid,
    ),
  ),
);
/**
 * Accept only an invitation for the signed-in user's email, enforced by Better Auth.
 * `alreadyMember` names the organization when this repeats an earlier acceptance.
 */
export const acceptInvitationAtom = BrowserAtoms.fn((invitationId: string, get) =>
  request("acceptInvitation", (options) =>
    organizationOperations(options).acceptInvitation(invitationId),
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          member: Schema.Struct({ organizationId: OrganizationId }),
          alreadyMember: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
        }),
      ),
    ),
    Effect.map((result) => ({
      organization: result.member.organizationId,
      alreadyMember: result.alreadyMember,
    })),
    Effect.tap(() => Effect.sync(() => get.refresh(organizationsAtom))),
  ),
);
