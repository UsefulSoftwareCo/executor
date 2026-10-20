import {
  Effect,
  makeDelegationService,
  Subject,
  Tenant,
  type VerifiedDelegatedCredential,
  type DelegationService,
  type DelegationStoreOptions,
} from "@executor-js/sdk";
import type { ExecutorDbHandle } from "@executor-js/api/server";
import type { VerifiedHumanSubjectRegistry } from "@executor-js/sdk";

import type { CloudflareConfig } from "../config";
import {
  classifyAccessClaims,
  delegatedCredentialFromAccessClaims,
  hasRecentAccessAuthentication,
  makeAccessVerifier,
  type AccessVerifierOptions,
} from "./cloudflare-access";

/** Every authority callback is required. A registry sighting cannot substitute
 * for live membership/admin policy, and proof must be checked by the provider
 * adapter before a challenge can become a grant. */
export type CloudflareDelegationAuthority = Pick<
  DelegationStoreOptions,
  "isVerifiedHuman" | "isCurrentlyAuthorized" | "isManagementAuthorized" | "verifyProof"
>;

/**
 * Build the Cloudflare delegation service over the request/DO's D1 handle.
 *
 * The authority callbacks own the live Access human registry, tenant
 * membership, admin policy, and provider proof check. They are required here
 * so this constructor cannot silently turn a sighting into authorization.
 */
export const makeCloudflareDelegationService = (
  dbHandle: Pick<ExecutorDbHandle, "db">,
  config: CloudflareConfig,
  authority: CloudflareDelegationAuthority,
): DelegationService => {
  const tenant = Tenant.make(config.organizationId);
  return makeDelegationService({
    db: dbHandle.db,
    tenant,
    issuanceEnabled: config.delegatedIssuanceEnabled,
    maxTtlMs: config.delegatedMaxTtlMs,
    isVerifiedHuman: authority.isVerifiedHuman,
    isCurrentlyAuthorized: authority.isCurrentlyAuthorized,
    isManagementAuthorized: authority.isManagementAuthorized,
    verifyProof: authority.verifyProof,
  });
};

const sameCredential = (
  left: VerifiedDelegatedCredential,
  right: VerifiedDelegatedCredential,
): boolean =>
  left.kind === right.kind &&
  left.adapter === right.adapter &&
  left.issuer === right.issuer &&
  left.audience === right.audience &&
  left.subject === right.subject &&
  left.credentialRef === right.credentialRef;

const machineActorFor = (credential: VerifiedDelegatedCredential): string =>
  `access:${credential.credentialRef}`;

/** Build live Access-backed authority callbacks for one request. The request's
 * signed JWT is rechecked for each possession/current-authorization decision;
 * a prior human sighting alone never authorizes a machine or administrator. */
export const makeCloudflareDelegationAuthority = (
  config: CloudflareConfig,
  registry: VerifiedHumanSubjectRegistry,
  request: Request,
  verifierOptions: AccessVerifierOptions = {},
): CloudflareDelegationAuthority => {
  const verifier = makeAccessVerifier(config, verifierOptions);
  const verifiedRequest = () => verifier.verifyWithClaims(request);
  const verifiedHuman = (subject: Subject) =>
    registry.isVerifiedHuman({ tenant: config.organizationId, subject: String(subject) });
  const verifiedMachineCredential = (credential: VerifiedDelegatedCredential) =>
    Effect.gen(function* () {
      const verified = yield* verifiedRequest();
      if (!verified || classifyAccessClaims(verified.claims) !== "service-token") return false;
      const presented = delegatedCredentialFromAccessClaims(verified.claims, config);
      return presented !== null && sameCredential(presented, credential);
    });

  return {
    isVerifiedHuman: verifiedHuman,
    isCurrentlyAuthorized: (grant) =>
      Effect.gen(function* () {
        const targetVerified = yield* verifiedHuman(grant.effectiveSubject);
        if (!targetVerified) return false;
        const verified = yield* verifiedRequest();
        if (!verified || classifyAccessClaims(verified.claims) !== "service-token") return false;
        const credential = delegatedCredentialFromAccessClaims(verified.claims, config);
        if (credential === null || machineActorFor(credential) !== String(grant.actorSubject)) {
          return false;
        }
        return machineActorFor(credential) === String(grant.actorSubject);
      }),
    isManagementAuthorized: (actorSubject, targetSubject) =>
      Effect.gen(function* () {
        const verified = yield* verifiedRequest();
        if (!verified || classifyAccessClaims(verified.claims) !== "human") return false;
        if (verified.principal.accountId !== String(actorSubject)) return false;
        if (
          !hasRecentAccessAuthentication(
            verified.claims,
            config.delegatedRecentAuthMaxAgeMs,
            Date.now(),
            config.delegatedRecentAuthClaim,
          )
        ) {
          return false;
        }
        const target = String(targetSubject ?? actorSubject);
        if (!(yield* verifiedHuman(Subject.make(target)))) return false;
        return target === String(actorSubject) || verified.principal.orgRole === "admin";
      }),
    verifyProof: (input) =>
      verifiedMachineCredential(input.credential).pipe(
        Effect.map(
          (valid) => valid && machineActorFor(input.credential) === String(input.machineActor),
        ),
      ),
  };
};
