// ---------------------------------------------------------------------------
// The owner a provider item id embeds — the single parser for the id grammar
// the SDK constructs (accessItemId in oauth-service.ts, the connection value
// ids in executor.ts, the oauth-client secret ids):
//
//   connection:<owner>:<integration>:<name>:<variable>
//   oauth:<owner>:<integration>:<name>[:refresh[:store-probe]]
//   oauth-client:<owner>:<slug>:secret
//
// The `:store-probe` tail is the one id here that holds no credential: a
// refresh writes it to prove the store accepts writes before a grant spends
// the refresh token. It hangs off the refresh id so it inherits the same
// owner, and therefore the same partition, as the credential it stands in for.
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
