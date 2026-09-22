import { protectedQuery } from "./protected-query.ts";
import {
  organizationTargetAtom,
  organizationPresentationAtom,
  organizationAccessVersionAtom,
} from "./organization-reference.ts";
import { OrganizationReference, OrganizationSlug } from "@executor-js/hosted-server/organization";
import { traceHeaders } from "@executor-js/telemetry";
import { BrowserAtoms } from "./telemetry.ts";
import { UploadedOrganizationIcon } from "@executor-js/hosted-server/organization-icon";
import { OrganizationForbidden } from "@executor-js/hosted-server/organization";
import { OrganizationId } from "@executor-js/hosted-server/organization";
import { Effect, Schema } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { organizationOperations, sessionAtom } from "./auth.ts";
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
  run: (options: {
    headers: Readonly<Record<string, string>>;
  }) => Promise<
    { data: A; error: null } | { data: null; error: { status: number; code?: string | undefined } }
  >,
) =>
  Effect.flatMap(traceHeaders, (headers) =>
    Effect.tryPromise({
      try: () => run({ headers }),
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

/** Refresh when the session changes, including switching users in this browser. */
const organizationsQuery = BrowserAtoms.atom((get) => {
  const session = get(sessionAtom);
  if (!AsyncResult.isSuccess(session) || session.value === null) return Effect.succeed([]);
  return request("list", (options) => organizationOperations(options).list()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OrganizationSummary))),
  );
}).pipe(Atom.refreshOnWindowFocus);

/** Confirmed writes and source waiting state are shared by every route consumer. */
export const organizationsAtom = acknowledgedQuery(organizationsQuery);

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
    .pipe(Atom.refreshOnWindowFocus, currentQuery),
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
  HostedClient.query("organization", "inventory", { params: { organization } }).pipe(
    Atom.refreshOnWindowFocus,
    protectedQuery,
  ),
);
/** Follow native pagination so search includes members beyond Better Auth's first page. */
export const membersAtom = Atom.family((organizationId: OrganizationId) =>
  BrowserAtoms.atom(
    Effect.gen(function* () {
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
      const invitations = yield* request("invitations", (options) =>
        organizationOperations(options).invitations(organizationId),
      );
      return { members, invitations };
    }),
  ).pipe(Atom.refreshOnWindowFocus, acknowledgedQuery),
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
/** Accept only an invitation for the signed-in user's email, enforced by Better Auth. */
export const acceptInvitationAtom = BrowserAtoms.fn((invitationId: string, get) =>
  request("acceptInvitation", (options) =>
    organizationOperations(options).acceptInvitation(invitationId),
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({ member: Schema.Struct({ organizationId: OrganizationId }) }),
      ),
    ),
    Effect.map((result) => result.member.organizationId),
    Effect.tap(() => Effect.sync(() => get.refresh(organizationsAtom))),
  ),
);
