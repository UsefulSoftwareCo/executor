import { Effect, Predicate } from "effect";

import { type DirectoryMember, type MemberDirectoryShape } from "@executor-js/api/server";
import {
  makeDelegationService,
  StorageError,
  Subject,
  Tenant,
  type DelegationService,
  type DelegationGrant,
  type FumaDb,
  type StorageFailure,
  type VerifiedDelegatedCredential,
} from "@executor-js/sdk";

import type { ApiKeyOwner } from "./api-keys";

type ApiKeys = {
  readonly listUserKeys: (input: {
    readonly accountId: string;
    readonly organizationId: string;
  }) => Effect.Effect<readonly { readonly id: string }[], unknown>;
};

const storageFailure = (operation: string, cause: unknown): StorageError =>
  new StorageError({ message: `Delegation authority ${operation} failed.`, operation, cause });

const mapStorage = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, StorageFailure> =>
  effect.pipe(Effect.mapError((cause) => storageFailure("delegation.authority", cause)));

const activeMember = (
  directory: MemberDirectoryShape,
  accountId: string,
  organizationId: string,
): Effect.Effect<DirectoryMember | null, StorageFailure> =>
  mapStorage(directory.membership(accountId, organizationId, ["active"]));

const keyIsBoundToTarget = (
  apiKeys: ApiKeys,
  credential: VerifiedDelegatedCredential,
  effectiveSubject: string,
  organizationId: string,
): Effect.Effect<boolean, StorageFailure> =>
  mapStorage(apiKeys.listUserKeys({ accountId: effectiveSubject, organizationId })).pipe(
    Effect.map((keys) => keys.some((key) => key.id === credential.credentialRef)),
  );

const machineKeyId = (subject: string): string | null =>
  subject.startsWith("machine:") ? subject.slice("machine:".length) : null;

export interface CloudDelegationServiceOptions {
  readonly db: FumaDb;
  readonly tenant: string;
  readonly directory: MemberDirectoryShape;
  readonly apiKeys: ApiKeys;
  readonly issuanceEnabled?: boolean;
  readonly maxTtlMs?: number;
  readonly verifyProof?: (input: {
    readonly challengeId: string;
    readonly credential: VerifiedDelegatedCredential;
    readonly machineActor: string;
    readonly nonce: string;
  }) => Effect.Effect<boolean, StorageFailure>;
  readonly verifyProviderCredential?: (input: {
    readonly credential: VerifiedDelegatedCredential;
    readonly actorSubject: Subject;
    readonly effectiveSubject: Subject;
  }) => Effect.Effect<boolean, StorageFailure>;
}

/**
 * The WorkOS authority used by both the bearer resolver and account API.
 * WorkOS only supplies a stable API-key id after validation; the SDK stores
 * that id as the credential reference and re-checks the key owner on every
 * delegated request. The bearer secret never crosses this boundary.
 */
export const makeCloudDelegationService = (
  options: CloudDelegationServiceOptions,
): DelegationService =>
  makeDelegationService({
    db: options.db,
    tenant: Tenant.make(options.tenant),
    issuanceEnabled: options.issuanceEnabled,
    maxTtlMs: options.maxTtlMs,
    isVerifiedHuman: (subject) =>
      activeMember(options.directory, String(subject), options.tenant).pipe(
        Effect.map((member) => member !== null),
      ),
    isCurrentlyAuthorized: (grant) =>
      Effect.gen(function* () {
        const target = yield* activeMember(
          options.directory,
          String(grant.effectiveSubject),
          options.tenant,
        );
        if (!target) return false;
        const keyId = machineKeyId(String(grant.actorSubject));
        if (!keyId) return false;
        return yield* keyIsBoundToTarget(
          options.apiKeys,
          {
            kind: "issued-key",
            adapter: "workos-api-key",
            issuer: "workos",
            audience: options.tenant,
            subject: String(grant.effectiveSubject),
            credentialRef: keyId,
          },
          String(grant.effectiveSubject),
          options.tenant,
        );
      }),
    isManagementAuthorized: (actorSubject, targetSubject) =>
      Effect.gen(function* () {
        const actor = yield* activeMember(options.directory, String(actorSubject), options.tenant);
        if (!actor) return false;
        if (String(targetSubject ?? actorSubject) === String(actorSubject)) return true;
        return actor.role === "admin";
      }),
    // The bearer resolver uses `resolve`, while the account adapter supplies a
    // request-bound proof callback for challenges. Keeping this callback
    // conservative prevents a nonce-only proof from becoming authorization.
    verifyProof: (input) =>
      options.verifyProof?.({
        challengeId: input.challengeId,
        credential: input.credential,
        machineActor: String(input.machineActor),
        nonce: input.nonce,
      }) ?? Effect.succeed(false),
    verifyProviderCredential: ({ credential, effectiveSubject, actorSubject }) =>
      options.verifyProviderCredential === undefined
        ? credential.adapter !== "workos-api-key"
          ? Effect.succeed(false)
          : keyIsBoundToTarget(
              options.apiKeys,
              credential,
              String(effectiveSubject),
              options.tenant,
            )
        : options.verifyProviderCredential({ credential, actorSubject, effectiveSubject }),
  });

/** Stable tuple for a validated WorkOS user API key. */
export const workosDelegatedCredential = (
  owner: ApiKeyOwner,
  issuer: string,
): VerifiedDelegatedCredential | null =>
  owner.scope === "user" && owner.accountId !== null
    ? {
        kind: "issued-key",
        adapter: "workos-api-key",
        issuer,
        audience: owner.organizationId,
        subject: owner.accountId,
        credentialRef: owner.keyId,
      }
    : null;

export const isDelegationUnmapped = (error: unknown): boolean =>
  Predicate.isTagged(error, "DelegationDeniedError") &&
  Predicate.hasProperty("reason")(error) &&
  error.reason === "unmapped";

export type CloudDelegationPrincipal = {
  readonly kind: "delegated";
  readonly accountId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug?: string;
  readonly email: "";
  readonly name: null;
  readonly avatarUrl: null;
  readonly roles: readonly [];
  readonly orgRoleModel: "organization";
  readonly orgRole: "member";
  readonly tenant: string;
  readonly grantId: string;
  readonly credentialId: string;
  readonly credentialRef: string;
  readonly actorSubject: string;
  readonly effectiveSubject: string;
  readonly scopeVersion: string;
  readonly delegation: DelegationGrant;
};
