import {
  makeDelegationService,
  Tenant,
  type DelegationService,
  type DelegationStoreOptions,
} from "@executor-js/sdk";

import type { SelfHostConfig } from "../config";
import type { BetterAuthHandle } from "./better-auth";
import type { SelfHostDbHandle } from "../db/self-host-db";

/** The self-host factory requires live Better Auth membership/admin and the
 * provider's possession check. A subject sighting alone is insufficient. */
export type SelfHostDelegationAuthority = Pick<
  DelegationStoreOptions,
  | "isVerifiedHuman"
  | "isCurrentlyAuthorized"
  | "isManagementAuthorized"
  | "verifyProof"
  | "verifyProviderCredential"
>;

/** Build the Better Auth/self-host delegation service over the shared SQLite
 * Fuma handle. The supplied authority must use live Better Auth membership and
 * admin reads on every management/revalidation decision. */
export const makeSelfHostDelegationService = (
  dbHandle: Pick<SelfHostDbHandle, "db">,
  betterAuth: Pick<BetterAuthHandle, "organizationId">,
  config: Pick<SelfHostConfig, "delegatedIssuanceEnabled" | "delegatedMaxTtlMs">,
  authority: SelfHostDelegationAuthority,
): DelegationService => {
  const tenant = Tenant.make(betterAuth.organizationId);
  return makeDelegationService({
    db: dbHandle.db,
    tenant,
    issuanceEnabled: config.delegatedIssuanceEnabled,
    maxTtlMs: config.delegatedMaxTtlMs,
    isVerifiedHuman: authority.isVerifiedHuman,
    isCurrentlyAuthorized: authority.isCurrentlyAuthorized,
    isManagementAuthorized: authority.isManagementAuthorized,
    verifyProof: authority.verifyProof,
    verifyProviderCredential: authority.verifyProviderCredential,
  });
};
