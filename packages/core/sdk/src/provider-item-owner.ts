// ---------------------------------------------------------------------------
// The owner a provider item id embeds — the single parser for the id grammar
// the SDK constructs (accessItemId in oauth-service.ts, the connection value
// ids in executor.ts, the oauth-client secret ids):
//
//   connection:<owner>:<integration>:<name>:<variable>
//   oauth:<owner>:<integration>:<name>[:refresh]
//   oauth-client:<owner>:<slug>:secret
//   work-identity:<owner>:<idp-client-owner>:<idp-client>
//
// Credential providers file plugin-storage rows by THIS owner, not the acting
// caller's binding — an org connection whose OAuth consent completes in one
// member's browser session must produce rows every member can resolve
// (issues #950, #1453).
// ---------------------------------------------------------------------------

import { Owner } from "./ids";
import type { OwnerBinding } from "./plugin";

/** Item-id prefixes whose SECOND colon-segment is the owning partition. */
export const OWNER_SCOPED_ITEM_ID_PREFIXES: ReadonlySet<string> = new Set([
  "connection",
  "oauth",
  "oauth-client",
  // A held enterprise identity is filed under the owner its enterprise-managed
  // connections are made under, for the same reason (#950, #1453): a Workspace
  // connection linked in one member's browser must stay resolvable by the rest
  // of the org, and a Personal one must stay private to its subject.
  "work-identity",
]);

/** The owner a logical item id embeds, or null for ids that carry none
 *  (legacy random `secret_*` ids). Reads the second colon-segment of the
 *  owner-scoped prefixes. */
export const embeddedItemOwner = (id: string): Owner | null => {
  const [prefix, owner] = id.split(":");
  if (OWNER_SCOPED_ITEM_ID_PREFIXES.has(prefix ?? "") && (owner === "org" || owner === "user")) {
    return Owner.make(owner);
  }
  return null;
};

/** Map the executor's (tenant, subject?) binding onto the storage `Owner`
 *  literal: a bound subject writes the user's own partition, otherwise the
 *  org-shared one. Fallback only — prefer `ownerForItemId`. */
const ownerOf = (binding: OwnerBinding): Owner =>
  binding.subject == null ? Owner.make("org") : Owner.make("user");

/** The partition a credential belongs to: the CREDENTIAL's owner (embedded in
 *  the item id), not the acting caller's binding. Ids without an embedded
 *  owner fall back to the caller binding. */
export const ownerForItemId = (id: string, binding: OwnerBinding): Owner =>
  embeddedItemOwner(id) ?? ownerOf(binding);
