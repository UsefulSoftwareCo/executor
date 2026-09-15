// ---------------------------------------------------------------------------
// The admin users plane's directory, derived from the shared `MemberDirectory`
// seam — so each host's `AdminUsersProvider` no longer carries its own
// identity join and email resolver.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { MemberStatus, type MemberDirectoryShape } from "../server/member-directory";
import type { AdminUserDirectory, AdminUserIdentity } from "./reads";

/**
 * Every direction of the admin plane's directory over one org's
 * {@link MemberDirectoryShape}.
 *
 * `identities` is one batched `membersById` read for the page of ids (never a
 * lookup per user); a member the org does not hold reports absent identity.
 * `resolveEmail` receives the already-normalized email the contract promises
 * and answers with the host principal id, or `null` when no member has it.
 * `search` is one `members` read for the term, answering with the matching
 * principal ids in directory order.
 *
 * Every direction reads ANY membership status — the same reach `membersById`
 * and `findByEmail` have by contract, and `search` asks for explicitly rather
 * than taking `members`' active + pending default. This plane reports
 * footprint, not current access: a member who was deactivated while their
 * connections remain must still be findable by the address or name an
 * operator has for them, exactly as `?email=` already finds them.
 *
 * All fail with `MemberDirectoryError`, which the shared reads treat as a
 * decorative-join outage (identities) or surface as a failed read (resolve,
 * search).
 */
export const adminUserDirectoryFromMembers = (
  directory: MemberDirectoryShape,
  organizationId: string,
): AdminUserDirectory => ({
  identities: (externalIds) =>
    directory.membersById(organizationId, externalIds, MemberStatus.literals).pipe(
      Effect.map((members) => {
        const identities = new Map<string, AdminUserIdentity>();
        for (const [accountId, member] of members) {
          identities.set(accountId, {
            email: member.email,
            displayName: member.name,
          });
        }
        return identities;
      }),
    ),
  resolveEmail: (email) =>
    directory
      .findByEmail(organizationId, email, MemberStatus.literals)
      .pipe(Effect.map((member) => (member === null ? null : member.accountId))),
  search: (term) =>
    directory
      .members(organizationId, { search: term, statuses: MemberStatus.literals })
      .pipe(Effect.map((members) => members.map((member) => member.accountId))),
});
