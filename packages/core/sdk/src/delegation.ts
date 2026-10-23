import { Effect, Option, Predicate, Schema } from "effect";

import {
  DelegationDeniedError,
  makeFumaClient,
  StorageError,
  type FumaDb,
  type StorageFailure,
} from "./fuma-runtime";
import { withQueryContext } from "@executor-js/fumadb/query";
import type { Condition, ConditionBuilder } from "@executor-js/fumadb/query";
import type { AnyColumn } from "@executor-js/fumadb/schema";
import type { ExecutorOwnerPolicyContext } from "./owner-policy";
import {
  ConnectionAddress,
  CredentialId,
  DelegationId,
  DelegationScopeVersion,
  Subject,
  Tenant,
  ToolAddress,
} from "./ids";

export const DEFAULT_DELEGATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DELEGATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const PROOF_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type DelegationScopeAction = "discover" | "invoke";

/** A verified credential after a host adapter has checked its signature and
 * issuer. The SDK deliberately knows no provider-specific credential shape. */
export interface VerifiedDelegatedCredential {
  readonly adapter: string;
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  /** Stable provider key id/reference; never the bearer secret. */
  readonly credentialRef: string;
  readonly kind: "external" | "issued-key";
}

/** Exact immutable membership captured at consent. Wildcards are forbidden. */
export interface DelegationScope {
  /** Closed v1 action set. Discovery covers catalog/schema; invoke also covers
   * approval and resume continuations for an already-authorized invocation. */
  readonly actions: readonly DelegationScopeAction[];
  readonly toolkitMembership: readonly {
    readonly toolkitId: string;
    readonly revision: string;
    readonly toolAddresses: readonly string[];
    readonly connectionAddresses: readonly string[];
  }[];
  readonly toolAddresses: readonly string[];
  /** Omitted means the frozen toolkit connection membership; [] denies all. */
  readonly connectionAddresses?: readonly string[];
}

export type DelegationOperation =
  | "catalog"
  | "schema"
  | "invoke"
  | "approval"
  | "resume"
  | "management";

export interface DelegationCapability {
  readonly operation: DelegationOperation;
  readonly tool?: ToolAddress;
  readonly connection?: ConnectionAddress;
  readonly requestId?: string;
  readonly executionId?: string;
}

export interface DelegatedPrincipal {
  readonly kind: "delegated";
  readonly tenant: Tenant;
  readonly grantId: DelegationId;
  readonly credentialId: CredentialId;
  readonly actorSubject: Subject;
  readonly effectiveSubject: Subject;
  readonly scopeVersion: DelegationScopeVersion;
  readonly credentialRef: string;
}

/** Serializable request/session binding. Hosts may persist this metadata, but
 * the SDK always resolves it back to the durable row before authorizing. */
export interface DelegationBinding {
  readonly tenant: Tenant;
  readonly grantId: DelegationId;
  readonly credentialId: CredentialId;
  readonly credentialRef: string;
  readonly actorSubject: Subject;
  readonly effectiveSubject: Subject;
  readonly scopeVersion: DelegationScopeVersion;
}

export interface DelegationContext extends DelegatedPrincipal {
  readonly expiresAt: number;
  readonly scope: DelegationScope;
  /** Live check. A context is never authorization evidence by itself. */
  readonly revalidate: (
    capability: DelegationCapability,
  ) => Effect.Effect<void, DelegationDeniedError | StorageFailure>;
}

export type DelegationGrant = DelegationContext;

export interface DelegationStoreOptions {
  readonly db: FumaDb;
  readonly tenant: Tenant;
  readonly issuanceEnabled?: boolean;
  readonly now?: () => number;
  /** Host-authoritative membership and disabled-user check. */
  readonly isVerifiedHuman: (subject: Subject) => Effect.Effect<boolean, StorageFailure>;
  /** Re-checks current actor/target authorization on every request. */
  readonly isCurrentlyAuthorized: (
    grant: Pick<DelegationGrant, "actorSubject" | "effectiveSubject" | "tenant">,
  ) => Effect.Effect<boolean, StorageFailure>;
  /** Human-session authorization for grant creation/revocation. */
  readonly isManagementAuthorized: (
    actorSubject: Subject,
    targetSubject?: Subject,
  ) => Effect.Effect<boolean, StorageFailure>;
  /** Operator-configurable upper bound; defaults to 90 days. */
  readonly maxTtlMs?: number;
  /** Host adapter verification is mandatory; nonce-only fallback is forbidden. */
  readonly verifyProof: (input: {
    readonly challengeId: string;
    readonly credential: VerifiedDelegatedCredential;
    readonly machineActor: Subject;
    readonly nonce: string;
  }) => Effect.Effect<boolean, StorageFailure>;
  /** Provider-managed key registration is a trusted host boundary. The host
   * must verify that the provider key exists, belongs to the requested target,
   * and is usable by the supplied machine actor; omission fails closed. */
  readonly verifyProviderCredential?: (input: {
    readonly credential: VerifiedDelegatedCredential;
    readonly actorSubject: Subject;
    readonly effectiveSubject: Subject;
  }) => Effect.Effect<boolean, StorageFailure>;
}

export interface CreateDelegationInput {
  /** Human consent activates a previously proven challenge. */
  readonly proofChallengeId: string;
  readonly consentedBy: Subject;
  readonly scopeVersion?: DelegationScopeVersion;
}

export interface DelegationAuditEvent {
  readonly grantId?: DelegationId;
  readonly credentialId?: CredentialId;
  readonly actorSubject: Subject;
  readonly effectiveSubject: Subject;
  readonly action: string;
  readonly tool?: ToolAddress;
  readonly outcome: "allowed" | "denied" | "created" | "changed" | "revoked" | "challenge";
  readonly requestId?: string;
  readonly executionId?: string;
}

export interface ProofChallenge {
  readonly challengeId: string;
  readonly nonce: string;
  readonly adapter: string;
  readonly createdBy: Subject;
  readonly effectiveSubject: Subject;
  readonly label: string;
  readonly scope: DelegationScope;
  readonly grantExpiresAt: number;
  readonly expiresAt: number;
}

export interface ProofCompletion {
  readonly challengeId: string;
  readonly credential: VerifiedDelegatedCredential;
  readonly actorSubject: Subject;
  readonly effectiveSubject: Subject;
  readonly scope: DelegationScope;
}

export interface DelegationGrantView {
  readonly grantId: DelegationId;
  readonly label: string;
  readonly createdBy: Subject;
  readonly credentialId: CredentialId;
  readonly credentialKind: VerifiedDelegatedCredential["kind"];
  readonly adapter: string;
  /** Exact provider reference for server-side lifecycle operations. This is
   * intentionally absent from the HTTP summary, which uses the masked field. */
  readonly credentialRef: string;
  readonly credentialRefMasked: string;
  readonly actorSubject: Subject;
  readonly effectiveSubject: Subject;
  readonly scope: DelegationScope;
  readonly scopeVersion: DelegationScopeVersion;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
}

/** Status returned to the human console while a machine completes proof. The
 * public reference is always masked; the nonce and any bearer material stay
 * with the challenge caller and are never persisted in a projection. */
export interface DelegationChallengeView {
  readonly challengeId: string;
  readonly status: "awaiting-proof" | "proof-complete" | "consented" | "expired";
  readonly adapter: string;
  readonly createdBy: Subject;
  readonly effectiveSubject: Subject;
  readonly label: string;
  readonly scope: DelegationScope;
  readonly grantExpiresAt: number;
  readonly expiresAt: number;
  readonly proofConsumedAt: number | null;
  readonly consentConsumedAt: number | null;
  readonly provenCredentialKind: VerifiedDelegatedCredential["kind"] | null;
  readonly provenCredentialRefMasked: string | null;
  readonly provenActorSubject: Subject | null;
}

export interface CreateIssuedDelegationInput {
  readonly createdBy: Subject;
  readonly effectiveSubject: Subject;
  readonly label: string;
  readonly scope: DelegationScope;
  readonly expiresAt?: number;
  readonly scopeVersion?: DelegationScopeVersion;
  /** Host/provider identity for this local key. Defaults to the SDK's local
   * carrier and remains generic; it is never interpreted as an Access type. */
  readonly adapter?: string;
  readonly issuer?: string;
  readonly audience?: string;
}

export interface IssuedDelegationKey {
  readonly keyRef: string;
  /** Complete one-time bearer token: `<keyRef>.<256-bit-secret>`. */
  readonly secret: string;
  readonly grant: DelegationGrant;
}

export interface RotateIssuedDelegationInput {
  readonly credentialId: CredentialId;
  readonly actorSubject: Subject;
  readonly expiresAt?: number;
}

/** Register a key already created by a host/provider. The SDK persists only
 * the stable provider tuple and never receives the provider secret. */
export interface RegisterProviderIssuedDelegationInput {
  readonly createdBy: Subject;
  readonly effectiveSubject: Subject;
  readonly actorSubject: Subject;
  readonly label: string;
  readonly scope: DelegationScope;
  readonly credential: VerifiedDelegatedCredential;
  readonly expiresAt?: number;
  readonly scopeVersion?: DelegationScopeVersion;
}

export interface RotateProviderIssuedDelegationInput {
  readonly credentialId: CredentialId;
  /** Human operator who created the replacement provider key. */
  readonly managedBy: Subject;
  readonly actorSubject: Subject;
  readonly credential: VerifiedDelegatedCredential;
  readonly expiresAt?: number;
  readonly scopeVersion?: DelegationScopeVersion;
}

export interface ExpandDelegationInput {
  readonly credentialId: CredentialId;
  readonly consentedBy: Subject;
  readonly scope: DelegationScope;
  readonly expiresAt: number;
  /** Optional optimistic version supplied by a host/UI read. */
  readonly expectedScopeVersion?: DelegationScopeVersion;
  readonly scopeVersion?: DelegationScopeVersion;
}

export interface DelegationAuditRecord {
  readonly id: string;
  readonly grantId: DelegationId | null;
  readonly credentialId: CredentialId | null;
  readonly actorSubject: Subject;
  readonly effectiveSubject: Subject;
  readonly action: string;
  readonly tool: ToolAddress | null;
  readonly outcome: DelegationAuditEvent["outcome"];
  readonly requestId: string | null;
  readonly executionId: string | null;
  readonly occurredAt: number;
}

export interface DelegationNotificationRecord {
  readonly id: string;
  readonly grantId: DelegationId;
  readonly credentialId: CredentialId;
  readonly createdBy: Subject;
  readonly targetSubject: Subject;
  readonly label: string;
  readonly credentialKind: VerifiedDelegatedCredential["kind"];
  readonly createdAt: number;
  readonly readAt: number | null;
}

export interface DelegationService {
  readonly create: (
    input: CreateDelegationInput,
  ) => Effect.Effect<DelegationGrant, DelegationDeniedError | StorageFailure>;
  readonly resolve: (
    credential: VerifiedDelegatedCredential,
  ) => Effect.Effect<DelegationGrant, DelegationDeniedError | StorageFailure>;
  readonly resolveBinding: (
    binding: DelegationBinding,
  ) => Effect.Effect<DelegationGrant, DelegationDeniedError | StorageFailure>;
  readonly revalidate: (
    context: DelegationContext,
    capability: DelegationCapability,
  ) => Effect.Effect<void, DelegationDeniedError | StorageFailure>;
  readonly get: (
    grantId: DelegationId,
  ) => Effect.Effect<DelegationGrantView | null, StorageFailure>;
  readonly list: (input?: {
    readonly effectiveSubject?: Subject;
    readonly credentialId?: CredentialId;
    readonly includeRevoked?: boolean;
  }) => Effect.Effect<readonly DelegationGrantView[], StorageFailure>;
  readonly getChallenge: (
    challengeId: string,
  ) => Effect.Effect<DelegationChallengeView | null, StorageFailure>;
  readonly createIssuedKey: (
    input: CreateIssuedDelegationInput,
  ) => Effect.Effect<IssuedDelegationKey, DelegationDeniedError | StorageFailure>;
  readonly rotateIssuedKey: (
    input: RotateIssuedDelegationInput,
  ) => Effect.Effect<IssuedDelegationKey, DelegationDeniedError | StorageFailure>;
  readonly registerProviderIssuedKey: (
    input: RegisterProviderIssuedDelegationInput,
  ) => Effect.Effect<DelegationGrant, DelegationDeniedError | StorageFailure>;
  readonly rotateProviderIssuedKey: (
    input: RotateProviderIssuedDelegationInput,
  ) => Effect.Effect<DelegationGrant, DelegationDeniedError | StorageFailure>;
  /** Resolve the SDK-local `<keyRef>.<secret>` token format. Provider-managed
   * keys use the external adapter path and never pass bearer material here. */
  readonly resolveIssuedKey: (
    token: string,
  ) => Effect.Effect<DelegationGrant, DelegationDeniedError | StorageFailure>;
  readonly expand: (
    input: ExpandDelegationInput,
  ) => Effect.Effect<DelegationGrant, DelegationDeniedError | StorageFailure>;
  readonly revoke: (input: {
    readonly grantId: DelegationId;
    readonly actorSubject: Subject;
    readonly reason?: string;
  }) => Effect.Effect<void, DelegationDeniedError | StorageFailure>;
  readonly revokeAll: (input: {
    readonly effectiveSubject: Subject;
    readonly actorSubject: Subject;
  }) => Effect.Effect<number, DelegationDeniedError | StorageFailure>;
  readonly audit: (event: DelegationAuditEvent) => Effect.Effect<void, StorageFailure>;
  readonly listAudit: (input?: {
    readonly grantId?: DelegationId;
    readonly effectiveSubject?: Subject;
    readonly limit?: number;
  }) => Effect.Effect<readonly DelegationAuditRecord[], StorageFailure>;
  readonly listNotifications: (input: {
    readonly reader: Subject;
    readonly includeRead?: boolean;
  }) => Effect.Effect<
    readonly DelegationNotificationRecord[],
    DelegationDeniedError | StorageFailure
  >;
  readonly markNotificationRead: (input: {
    readonly notificationId: string;
    readonly reader: Subject;
  }) => Effect.Effect<void, DelegationDeniedError | StorageFailure>;
  readonly issueProofChallenge: (input: {
    readonly adapter: string;
    readonly createdBy: Subject;
    readonly effectiveSubject: Subject;
    readonly label: string;
    readonly scope: DelegationScope;
    readonly grantExpiresAt?: number;
  }) => Effect.Effect<ProofChallenge, StorageFailure>;
  readonly completeProofChallenge: (input: {
    readonly challengeId: string;
    readonly credential: VerifiedDelegatedCredential;
    readonly machineActor: Subject;
    readonly nonce: string;
  }) => Effect.Effect<ProofCompletion, DelegationDeniedError | StorageFailure>;
}

const ScopeSchema = Schema.Struct({
  actions: Schema.Array(Schema.Union([Schema.Literal("discover"), Schema.Literal("invoke")])),
  toolkitMembership: Schema.Array(
    Schema.Struct({
      toolkitId: Schema.String,
      revision: Schema.String,
      toolAddresses: Schema.Array(Schema.String),
      connectionAddresses: Schema.Array(Schema.String),
    }),
  ),
  toolAddresses: Schema.Array(Schema.String),
  connectionAddresses: Schema.optional(Schema.Array(Schema.String)),
});
const decodeScope = Schema.decodeUnknownOption(ScopeSchema);
const encodeScope = Schema.encodeUnknownSync(ScopeSchema);
const PersistedGrantSchema = Schema.Struct({
  tenant: Schema.String,
  id: Schema.String,
  label: Schema.String,
  created_by: Schema.String,
  credential_id: Schema.String,
  credential_kind: Schema.String,
  adapter: Schema.String,
  issuer: Schema.String,
  audience: Schema.String,
  credential_subject: Schema.String,
  credential_ref: Schema.String,
  issued_key_ref: Schema.NullOr(Schema.String),
  key_hash: Schema.NullOr(Schema.String),
  actor_subject: Schema.String,
  effective_subject: Schema.String,
  scope: Schema.Unknown,
  scope_version: Schema.String,
  expires_at: Schema.Number,
  revoked_at: Schema.NullOr(Schema.Number),
  created_at: Schema.Number,
  last_used_at: Schema.NullOr(Schema.Number),
});
type PersistedGrant = typeof PersistedGrantSchema.Type;
const decodeGrant = Schema.decodeUnknownOption(PersistedGrantSchema);
const PersistedChallengeSchema = Schema.Struct({
  tenant: Schema.String,
  id: Schema.String,
  created_by: Schema.String,
  label: Schema.String,
  credential_id: Schema.NullOr(Schema.String),
  credential_kind: Schema.NullOr(Schema.String),
  adapter: Schema.String,
  issuer: Schema.NullOr(Schema.String),
  audience: Schema.NullOr(Schema.String),
  credential_subject: Schema.NullOr(Schema.String),
  credential_ref: Schema.NullOr(Schema.String),
  actor_subject: Schema.NullOr(Schema.String),
  effective_subject: Schema.String,
  scope: Schema.Unknown,
  proof_hash: Schema.String,
  expires_at: Schema.Number,
  grant_expires_at: Schema.Number,
  proof_consumed_at: Schema.NullOr(Schema.Number),
  consent_consumed_at: Schema.NullOr(Schema.Number),
  created_at: Schema.Number,
});
type PersistedChallenge = typeof PersistedChallengeSchema.Type;
const decodeChallenge = Schema.decodeUnknownOption(PersistedChallengeSchema);
const PersistedAuditSchema = Schema.Struct({
  tenant: Schema.String,
  id: Schema.String,
  grant_id: Schema.NullOr(Schema.String),
  credential_id: Schema.NullOr(Schema.String),
  actor_subject: Schema.String,
  effective_subject: Schema.String,
  action: Schema.String,
  tool: Schema.NullOr(Schema.String),
  outcome: Schema.Union([
    Schema.Literal("allowed"),
    Schema.Literal("denied"),
    Schema.Literal("created"),
    Schema.Literal("changed"),
    Schema.Literal("revoked"),
    Schema.Literal("challenge"),
  ]),
  request_id: Schema.NullOr(Schema.String),
  execution_id: Schema.NullOr(Schema.String),
  occurred_at: Schema.Number,
});
type PersistedAudit = typeof PersistedAuditSchema.Type;
const decodeAudit = Schema.decodeUnknownOption(PersistedAuditSchema);
const PersistedNotificationSchema = Schema.Struct({
  tenant: Schema.String,
  id: Schema.String,
  grant_id: Schema.String,
  credential_id: Schema.String,
  created_by: Schema.String,
  target_subject: Schema.String,
  label: Schema.String,
  credential_kind: Schema.String,
  created_at: Schema.Number,
  read_at: Schema.NullOr(Schema.Number),
});
type PersistedNotification = typeof PersistedNotificationSchema.Type;
const decodeNotification = Schema.decodeUnknownOption(PersistedNotificationSchema);
type AnyDelegationBuilder = ConditionBuilder<Record<string, AnyColumn>>;

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 255;
const validEpoch = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const validMaxTtl = (value: number): boolean =>
  validEpoch(value) && value > 0 && value <= MAX_DELEGATION_TTL_MS;
const validScopeVersion = (value: DelegationScopeVersion | undefined): boolean =>
  value === undefined || nonEmpty(value);
const validTtlWindow = (issuedAt: number, expiresAt: number, maxTtlMs: number): boolean => {
  const limit = issuedAt + maxTtlMs;
  return (
    validEpoch(issuedAt) &&
    validEpoch(expiresAt) &&
    validMaxTtl(maxTtlMs) &&
    validEpoch(limit) &&
    expiresAt > issuedAt &&
    expiresAt <= limit
  );
};
const validCredentialTuple = (value: {
  readonly credential_kind: unknown;
  readonly adapter: unknown;
  readonly issuer: unknown;
  readonly audience: unknown;
  readonly credential_subject: unknown;
  readonly credential_ref: unknown;
}): boolean =>
  (value.credential_kind === "external" || value.credential_kind === "issued-key") &&
  [
    value.adapter,
    value.issuer,
    value.audience,
    value.credential_subject,
    value.credential_ref,
  ].every(nonEmpty);
const validCredential = (value: VerifiedDelegatedCredential): boolean =>
  (() => {
    const record = asRecord(value);
    return (
      record !== null &&
      validCredentialTuple({
        credential_kind: record.kind,
        adapter: record.adapter,
        issuer: record.issuer,
        audience: record.audience,
        credential_subject: record.subject,
        credential_ref: record.credentialRef,
      })
    );
  })();
const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((a, b) => a.localeCompare(b));

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const epochNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "bigint") {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return value >= 0n && value <= max ? Number(value) : null;
  }
  if (value instanceof Date) {
    const epoch = value.getTime();
    return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
  }
  return null;
};
const normalizeEpochFields = (
  value: unknown,
  fields: readonly { readonly name: string; readonly nullable: boolean }[],
): Record<string, unknown> | null => {
  const record = asRecord(value);
  if (!record) return null;
  const output = { ...record };
  for (const field of fields) {
    const source = record[field.name];
    if (source === null && field.nullable) continue;
    const normalized = epochNumber(source);
    if (normalized === null) return null;
    output[field.name] = normalized;
  }
  return output;
};

const randomHex = (bytes = 32): string => {
  const output = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(output);
  return [...output].map((value) => value.toString(16).padStart(2, "0")).join("");
};

const maskReference = (value: string): string => {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
};

const invalidStoredRow = (table: string): StorageError =>
  new StorageError({
    message: `Delegation record in ${table} is invalid.`,
    operation: `delegation.${table}.read`,
    cause: undefined,
  });

const sha256Hex = (value: string): Effect.Effect<string, never> =>
  Effect.promise(async () => {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
  });

/** Compare bearer digests without returning early on the first differing byte. */
const constantTimeHexEqual = (left: string, right: string): boolean => {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    difference |= leftCode ^ rightCode;
  }
  return difference === 0;
};

const nowDate = (now: number): Date => new Date(now);

const denied = (reason: DelegationDeniedError["reason"], message: string): DelegationDeniedError =>
  new DelegationDeniedError({ reason, message });

const canonicalizeScope = (parsed: typeof ScopeSchema.Type): DelegationScope | null => {
  const isAction = (action: string): action is DelegationScopeAction =>
    action === "discover" || action === "invoke";
  if (parsed.actions.length === 0) {
    return null;
  }
  const actions = uniqueSorted(parsed.actions).filter(isAction);
  const tools = uniqueSorted(parsed.toolAddresses);
  const connections =
    parsed.connectionAddresses === undefined ? undefined : uniqueSorted(parsed.connectionAddresses);
  if (tools.some((tool) => tool.includes("*") || !nonEmpty(tool))) return null;
  if (connections?.some((connection) => connection.includes("*") || !nonEmpty(connection))) {
    return null;
  }
  const toolkitMembership = parsed.toolkitMembership.map((toolkit) => {
    if (!nonEmpty(toolkit.toolkitId) || !nonEmpty(toolkit.revision)) return null;
    return {
      toolkitId: toolkit.toolkitId,
      revision: toolkit.revision,
      toolAddresses: uniqueSorted(toolkit.toolAddresses).map((item) => ToolAddress.make(item)),
      connectionAddresses: uniqueSorted(toolkit.connectionAddresses).map((item) =>
        ConnectionAddress.make(item),
      ),
    };
  });
  if (toolkitMembership.some((value) => value === null)) return null;
  const validToolkitMembership = toolkitMembership.filter(Predicate.isNotNull);
  if (
    validToolkitMembership.some(
      (toolkit) =>
        !nonEmpty(toolkit.toolkitId) ||
        !nonEmpty(toolkit.revision) ||
        toolkit.toolAddresses.length === 0 ||
        toolkit.toolAddresses.some(
          (tool) => !nonEmpty(String(tool)) || String(tool).includes("*"),
        ) ||
        toolkit.connectionAddresses.some(
          (connection) => !nonEmpty(String(connection)) || String(connection).includes("*"),
        ),
    )
  ) {
    return null;
  }
  return {
    actions: actions.sort(),
    toolkitMembership: validToolkitMembership,
    toolAddresses: tools.map((value) => ToolAddress.make(value)),
    ...(connections === undefined
      ? {}
      : { connectionAddresses: connections.map((value) => ConnectionAddress.make(value)) }),
  };
};

const normalizeScope = (scope: DelegationScope): DelegationScope | null => {
  const decoded = decodeScope(scope);
  return Option.isNone(decoded) ? null : canonicalizeScope(decoded.value);
};

const includesAll = (container: readonly string[], required: readonly string[]): boolean =>
  required.every((value) => container.includes(value));

/** Expansion is deliberately monotonic. A caller that needs to narrow a
 * grant can revoke it and create a new consented grant, preserving a clear
 * audit trail and avoiding stale session assumptions. */
const isScopeExpansion = (previous: DelegationScope, next: DelegationScope): boolean => {
  if (!includesAll(next.actions, previous.actions)) return false;
  if (!includesAll(next.toolAddresses.map(String), previous.toolAddresses.map(String)))
    return false;
  const previousConnections =
    previous.connectionAddresses === undefined
      ? previous.toolkitMembership.flatMap((toolkit) => toolkit.connectionAddresses.map(String))
      : previous.connectionAddresses.map(String);
  const nextConnections =
    next.connectionAddresses === undefined
      ? next.toolkitMembership.flatMap((toolkit) => toolkit.connectionAddresses.map(String))
      : next.connectionAddresses.map(String);
  if (!includesAll(nextConnections, previousConnections)) return false;
  return previous.toolkitMembership.every((oldToolkit) => {
    const matching = next.toolkitMembership.find(
      (candidate) =>
        candidate.toolkitId === oldToolkit.toolkitId && candidate.revision === oldToolkit.revision,
    );
    return (
      matching !== undefined &&
      includesAll(matching.toolAddresses.map(String), oldToolkit.toolAddresses.map(String)) &&
      includesAll(
        matching.connectionAddresses.map(String),
        oldToolkit.connectionAddresses.map(String),
      )
    );
  });
};

const toGrant = (
  service: DelegationService,
  row: PersistedGrant,
  scope: DelegationScope,
): DelegationGrant => {
  const tenant = Tenant.make(row.tenant);
  const grantId = DelegationId.make(row.id);
  const context: DelegationGrant = {
    kind: "delegated",
    tenant,
    grantId,
    credentialId: CredentialId.make(row.credential_id),
    actorSubject: Subject.make(row.actor_subject),
    effectiveSubject: Subject.make(row.effective_subject),
    scopeVersion: DelegationScopeVersion.make(row.scope_version),
    credentialRef: row.credential_ref,
    expiresAt: row.expires_at,
    scope,
    revalidate: (capability) => service.revalidate(context, capability),
  };
  return context;
};

const rowScope = (row: { readonly scope: unknown }): DelegationScope | null => {
  const decoded = decodeScope(row.scope);
  return Option.isNone(decoded) ? null : canonicalizeScope(decoded.value);
};

/** Build the private grant store/resolver over the executor database. */
export const makeDelegationService = (options: DelegationStoreOptions): DelegationService => {
  const tenant = String(options.tenant);
  const now = options.now ?? Date.now;
  const tables = new Set([
    "credential_delegation",
    "delegation_challenge",
    "delegation_audit",
    "delegation_notification",
  ]);
  const context: ExecutorOwnerPolicyContext = { tenant, subject: null };
  const db = makeFumaClient(withQueryContext(options.db, context), { tables });
  let api: DelegationService;

  const tenantWhere = (
    builder: AnyDelegationBuilder,
    field: string,
    value: unknown,
  ): Condition | boolean => builder.and(builder("tenant", "=", tenant), builder(field, "=", value));

  const parseGrant = (row: unknown): PersistedGrant | null => {
    const decoded = decodeGrant(
      normalizeEpochFields(row, [
        { name: "expires_at", nullable: false },
        { name: "revoked_at", nullable: true },
        { name: "created_at", nullable: false },
        { name: "last_used_at", nullable: true },
      ]),
    );
    if (Option.isNone(decoded)) return null;
    const value = decoded.value;
    return nonEmpty(value.id) &&
      nonEmpty(value.label) &&
      nonEmpty(value.created_by) &&
      nonEmpty(value.actor_subject) &&
      nonEmpty(value.effective_subject) &&
      nonEmpty(value.scope_version) &&
      validCredentialTuple(value) &&
      validEpoch(value.expires_at) &&
      validEpoch(value.created_at) &&
      (value.revoked_at === null || validEpoch(value.revoked_at)) &&
      (value.last_used_at === null || validEpoch(value.last_used_at))
      ? value
      : null;
  };
  const parseChallenge = (row: unknown): PersistedChallenge | null => {
    const decoded = decodeChallenge(
      normalizeEpochFields(row, [
        { name: "expires_at", nullable: false },
        { name: "grant_expires_at", nullable: false },
        { name: "proof_consumed_at", nullable: true },
        { name: "consent_consumed_at", nullable: true },
        { name: "created_at", nullable: false },
      ]),
    );
    if (Option.isNone(decoded)) return null;
    const value = decoded.value;
    return nonEmpty(value.created_by) &&
      nonEmpty(value.label) &&
      nonEmpty(value.adapter) &&
      nonEmpty(value.effective_subject) &&
      validEpoch(value.expires_at) &&
      validEpoch(value.grant_expires_at) &&
      validEpoch(value.created_at) &&
      (value.proof_consumed_at === null || validEpoch(value.proof_consumed_at)) &&
      (value.consent_consumed_at === null || validEpoch(value.consent_consumed_at))
      ? value
      : null;
  };

  const parseAudit = (row: unknown): PersistedAudit | null => {
    const decoded = decodeAudit(
      normalizeEpochFields(row, [{ name: "occurred_at", nullable: false }]),
    );
    if (Option.isNone(decoded)) return null;
    const value = decoded.value;
    return nonEmpty(value.id) &&
      nonEmpty(value.actor_subject) &&
      nonEmpty(value.effective_subject) &&
      nonEmpty(value.action) &&
      validEpoch(value.occurred_at)
      ? value
      : null;
  };

  const parseNotification = (row: unknown): PersistedNotification | null => {
    const decoded = decodeNotification(
      normalizeEpochFields(row, [
        { name: "created_at", nullable: false },
        { name: "read_at", nullable: true },
      ]),
    );
    if (Option.isNone(decoded)) return null;
    const value = decoded.value;
    return nonEmpty(value.id) &&
      nonEmpty(value.grant_id) &&
      nonEmpty(value.credential_id) &&
      nonEmpty(value.created_by) &&
      nonEmpty(value.target_subject) &&
      nonEmpty(value.label) &&
      (value.credential_kind === "external" || value.credential_kind === "issued-key") &&
      validEpoch(value.created_at) &&
      (value.read_at === null || validEpoch(value.read_at))
      ? value
      : null;
  };

  const findGrant = (grantId: DelegationId) =>
    db
      .use("delegation.grant.get", (query) =>
        query.findFirst("credential_delegation", {
          where: (builder) => tenantWhere(builder, "id", String(grantId)),
        }),
      )
      .pipe(Effect.map(parseGrant));

  const toGrantView = (row: PersistedGrant, scope: DelegationScope): DelegationGrantView => ({
    grantId: DelegationId.make(row.id),
    label: row.label,
    createdBy: Subject.make(row.created_by),
    credentialId: CredentialId.make(row.credential_id),
    credentialKind: row.credential_kind === "issued-key" ? "issued-key" : "external",
    adapter: row.adapter,
    credentialRef: row.credential_ref,
    credentialRefMasked: maskReference(row.credential_ref),
    actorSubject: Subject.make(row.actor_subject),
    effectiveSubject: Subject.make(row.effective_subject),
    scope,
    scopeVersion: DelegationScopeVersion.make(row.scope_version),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  });

  const toNotificationRecord = (row: PersistedNotification): DelegationNotificationRecord => ({
    id: row.id,
    grantId: DelegationId.make(row.grant_id),
    credentialId: CredentialId.make(row.credential_id),
    createdBy: Subject.make(row.created_by),
    targetSubject: Subject.make(row.target_subject),
    label: row.label,
    credentialKind: row.credential_kind === "issued-key" ? "issued-key" : "external",
    createdAt: row.created_at,
    readAt: row.read_at,
  });

  const toChallengeView = (
    row: PersistedChallenge,
    scope: DelegationScope,
    currentTime: number,
  ): DelegationChallengeView => ({
    challengeId: row.id,
    status:
      row.consent_consumed_at !== null
        ? "consented"
        : row.expires_at <= currentTime
          ? "expired"
          : row.proof_consumed_at === null
            ? "awaiting-proof"
            : "proof-complete",
    adapter: row.adapter,
    createdBy: Subject.make(row.created_by),
    effectiveSubject: Subject.make(row.effective_subject),
    label: row.label,
    scope,
    grantExpiresAt: row.grant_expires_at,
    expiresAt: row.expires_at,
    proofConsumedAt: row.proof_consumed_at,
    consentConsumedAt: row.consent_consumed_at,
    provenCredentialKind:
      row.credential_kind === "issued-key" || row.credential_kind === "external"
        ? row.credential_kind
        : null,
    provenCredentialRefMasked:
      row.credential_ref === null ? null : maskReference(row.credential_ref),
    provenActorSubject: row.actor_subject === null ? null : Subject.make(row.actor_subject),
  });

  let audit: DelegationService["audit"];

  const checkCurrent = (grant: DelegationGrant) =>
    Effect.gen(function* () {
      if (grant.expiresAt <= now())
        return yield* Effect.fail(denied("expired", "Delegation expired."));
      const verified = yield* options.isVerifiedHuman(grant.effectiveSubject);
      if (!verified)
        return yield* Effect.fail(
          denied("unauthorized", "Delegated subject is no longer authorized."),
        );
      const authorized = yield* options.isCurrentlyAuthorized(grant);
      if (!authorized)
        return yield* Effect.fail(
          denied("unauthorized", "Delegation authorization is no longer current."),
        );
    });

  audit = (event: DelegationAuditEvent): Effect.Effect<void, StorageFailure> =>
    db
      .use("delegation.audit.create", (query) =>
        query.create("delegation_audit", {
          tenant,
          id: `audit_${randomHex(16)}`,
          grant_id: event.grantId ? String(event.grantId) : null,
          credential_id: event.credentialId ? String(event.credentialId) : null,
          actor_subject: String(event.actorSubject),
          effective_subject: String(event.effectiveSubject),
          action: event.action,
          tool: event.tool ? String(event.tool) : null,
          outcome: event.outcome,
          request_id: event.requestId ?? null,
          execution_id: event.executionId ?? null,
          occurred_at: nowDate(now()),
        }),
      )
      .pipe(Effect.asVoid);

  // Fuma's portable updateMany contract intentionally does not expose an
  // affected-row count. A deterministic, tenant-scoped audit id gives state
  // transitions a portable single-use claim: the database unique constraint
  // serializes contenders, while the enclosing transaction rolls the claim
  // back if the state update or grant insert fails.
  const claimOperation = (input: {
    readonly claimId: string;
    readonly action: string;
    readonly actorSubject: Subject;
    readonly effectiveSubject: Subject;
  }): Effect.Effect<void, StorageFailure> =>
    db
      .use(`delegation.claim.${input.action}`, (query) =>
        query.create("delegation_audit", {
          tenant,
          id: input.claimId,
          grant_id: null,
          credential_id: null,
          actor_subject: String(input.actorSubject),
          effective_subject: String(input.effectiveSubject),
          action: input.action,
          tool: null,
          outcome: "challenge",
          request_id: null,
          execution_id: null,
          occurred_at: nowDate(now()),
        }),
      )
      .pipe(Effect.asVoid);

  const claimChallengePhase = (input: {
    readonly challengeId: string;
    readonly phase: "proof" | "consent";
    readonly actorSubject: Subject;
    readonly effectiveSubject: Subject;
  }): Effect.Effect<void, StorageFailure> =>
    claimOperation({
      claimId: `delegation_claim_${input.phase}_${input.challengeId}`,
      action: `proof.${input.phase}.claim`,
      actorSubject: input.actorSubject,
      effectiveSubject: input.effectiveSubject,
    });

  const createNotification = (input: {
    readonly grantId: DelegationId;
    readonly credentialId: CredentialId;
    readonly createdBy: Subject;
    readonly targetSubject: Subject;
    readonly label: string;
    readonly credentialKind: VerifiedDelegatedCredential["kind"];
  }): Effect.Effect<void, StorageFailure> => {
    if (String(input.createdBy) === String(input.targetSubject)) return Effect.void;
    const id = `delegation_notification_${String(input.grantId)}`;
    return db
      .use("delegation.notification.find", (query) =>
        query.findFirst("delegation_notification", {
          where: (builder) =>
            builder.and(
              builder("tenant", "=", tenant),
              builder("grant_id", "=", String(input.grantId)),
              builder("target_subject", "=", String(input.targetSubject)),
            ),
        }),
      )
      .pipe(
        Effect.flatMap((existing) =>
          existing === null
            ? db.use("delegation.notification.create", (query) =>
                query.create("delegation_notification", {
                  tenant,
                  id,
                  grant_id: String(input.grantId),
                  credential_id: String(input.credentialId),
                  created_by: String(input.createdBy),
                  target_subject: String(input.targetSubject),
                  label: input.label,
                  credential_kind: input.credentialKind,
                  created_at: nowDate(now()),
                  read_at: null,
                }),
              )
            : (() => {
                const row = parseNotification(existing);
                if (
                  row === null ||
                  row.id !== id ||
                  row.grant_id !== String(input.grantId) ||
                  row.credential_id !== String(input.credentialId) ||
                  row.created_by !== String(input.createdBy) ||
                  row.target_subject !== String(input.targetSubject) ||
                  row.label !== input.label ||
                  row.credential_kind !== input.credentialKind
                ) {
                  return Effect.fail(invalidStoredRow("delegation_notification"));
                }
                return Effect.void;
              })(),
        ),
        // A retry or a concurrent transaction may win the unique grant/target
        // claim between the find and create. The durable row is the idempotency
        // key, so that race is already satisfied.
        Effect.catchTag("UniqueViolationError", () => Effect.void),
        Effect.asVoid,
      );
  };

  const withDenialAudit = <A>(
    operation: Effect.Effect<A, DelegationDeniedError | StorageFailure>,
    event: DelegationAuditEvent,
  ): Effect.Effect<A, DelegationDeniedError | StorageFailure> =>
    operation.pipe(
      Effect.catchTag("DelegationDeniedError", (error) =>
        audit({ ...event, outcome: "denied" }).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );

  const get = (grantId: DelegationId) =>
    Effect.gen(function* () {
      const raw = yield* findGrant(grantId);
      if (raw === null) return null;
      const scope = rowScope(raw);
      if (!scope) return yield* Effect.fail(invalidStoredRow("credential_delegation"));
      return toGrantView(raw, scope);
    });

  const list = (
    input: {
      readonly effectiveSubject?: Subject;
      readonly credentialId?: CredentialId;
      readonly includeRevoked?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      const rawRows = yield* db.use("delegation.grant.list", (query) =>
        query.findMany("credential_delegation", {
          where: (builder) => {
            const predicates: (Condition | boolean)[] = [builder("tenant", "=", tenant)];
            if (input.effectiveSubject !== undefined) {
              predicates.push(builder("effective_subject", "=", String(input.effectiveSubject)));
            }
            if (input.credentialId !== undefined) {
              predicates.push(builder("credential_id", "=", String(input.credentialId)));
            }
            if (input.includeRevoked !== true) predicates.push(builder.isNull("revoked_at"));
            return builder.and(...predicates);
          },
          orderBy: [
            ["created_at", "desc"],
            ["id", "desc"],
          ],
        }),
      );
      return yield* Effect.forEach(rawRows, (raw) => {
        const row = parseGrant(raw);
        if (!row) return Effect.fail(invalidStoredRow("credential_delegation"));
        const scope = rowScope(row);
        if (!scope) return Effect.fail(invalidStoredRow("credential_delegation"));
        return Effect.succeed(toGrantView(row, scope));
      });
    });

  const getChallenge = (challengeId: string) =>
    Effect.gen(function* () {
      if (!nonEmpty(challengeId)) return null;
      const raw = yield* db.use("delegation.challenge.status", (query) =>
        query.findFirst("delegation_challenge", {
          where: (builder) => tenantWhere(builder, "id", challengeId),
        }),
      );
      if (raw === null) return null;
      const row = parseChallenge(raw);
      if (!row) return yield* Effect.fail(invalidStoredRow("delegation_challenge"));
      const scope = rowScope(row);
      if (!scope) return yield* Effect.fail(invalidStoredRow("delegation_challenge"));
      return toChallengeView(row, scope, now());
    });

  const listAudit = (
    input: {
      readonly grantId?: DelegationId;
      readonly effectiveSubject?: Subject;
      readonly limit?: number;
    } = {},
  ) =>
    Effect.gen(function* () {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        return yield* new StorageError({
          message: "Delegation audit limit is invalid.",
          operation: "delegation.audit.list",
          cause: undefined,
        });
      }
      const rawRows = yield* db.use("delegation.audit.list", (query) =>
        query.findMany("delegation_audit", {
          where: (builder) => {
            const predicates: (Condition | boolean)[] = [builder("tenant", "=", tenant)];
            if (input.grantId !== undefined) {
              predicates.push(builder("grant_id", "=", String(input.grantId)));
            }
            if (input.effectiveSubject !== undefined) {
              predicates.push(builder("effective_subject", "=", String(input.effectiveSubject)));
            }
            return builder.and(...predicates);
          },
          orderBy: [
            ["occurred_at", "desc"],
            ["id", "desc"],
          ],
          limit,
        }),
      );
      return yield* Effect.forEach(rawRows, (raw) => {
        const row = parseAudit(raw);
        if (!row) return Effect.fail(invalidStoredRow("delegation_audit"));
        return Effect.succeed({
          id: row.id,
          grantId: row.grant_id === null ? null : DelegationId.make(row.grant_id),
          credentialId: row.credential_id === null ? null : CredentialId.make(row.credential_id),
          actorSubject: Subject.make(row.actor_subject),
          effectiveSubject: Subject.make(row.effective_subject),
          action: row.action,
          tool: row.tool === null ? null : ToolAddress.make(row.tool),
          outcome: row.outcome,
          requestId: row.request_id,
          executionId: row.execution_id,
          occurredAt: row.occurred_at,
        } satisfies DelegationAuditRecord);
      });
    });

  const listNotifications = (input: { readonly reader: Subject; readonly includeRead?: boolean }) =>
    Effect.gen(function* () {
      if (!nonEmpty(String(input.reader))) {
        return yield* Effect.fail(denied("invalid", "Notification reader is invalid."));
      }
      if (!(yield* options.isVerifiedHuman(input.reader))) {
        return yield* Effect.fail(
          denied("unauthorized", "Notification reader is not a verified human."),
        );
      }
      const rawRows = yield* db.use("delegation.notification.list", (query) =>
        query.findMany("delegation_notification", {
          where: (builder) => {
            const predicates: (Condition | boolean)[] = [
              builder("tenant", "=", tenant),
              builder("target_subject", "=", String(input.reader)),
            ];
            if (input.includeRead !== true) predicates.push(builder.isNull("read_at"));
            return builder.and(...predicates);
          },
          orderBy: [
            ["created_at", "desc"],
            ["id", "desc"],
          ],
        }),
      );
      return yield* Effect.forEach(rawRows, (raw) => {
        const row = parseNotification(raw);
        if (!row) return Effect.fail(invalidStoredRow("delegation_notification"));
        return Effect.succeed(toNotificationRecord(row));
      });
    });

  const markNotificationRead = (input: {
    readonly notificationId: string;
    readonly reader: Subject;
  }) =>
    Effect.gen(function* () {
      if (!nonEmpty(input.notificationId) || !nonEmpty(String(input.reader))) {
        return yield* Effect.fail(denied("invalid", "Notification binding is invalid."));
      }
      if (!(yield* options.isVerifiedHuman(input.reader))) {
        return yield* Effect.fail(
          denied("unauthorized", "Notification reader is not a verified human."),
        );
      }
      const raw = yield* db.use("delegation.notification.get", (query) =>
        query.findFirst("delegation_notification", {
          where: (builder) =>
            builder.and(
              builder("tenant", "=", tenant),
              builder("id", "=", input.notificationId),
              builder("target_subject", "=", String(input.reader)),
            ),
        }),
      );
      if (raw === null) {
        return yield* Effect.fail(denied("unauthorized", "Notification is unavailable."));
      }
      const row = parseNotification(raw);
      if (!row) return yield* Effect.fail(invalidStoredRow("delegation_notification"));
      if (row.read_at !== null) return;
      yield* db.use("delegation.notification.mark-read", (query) =>
        query.updateMany("delegation_notification", {
          where: (builder) =>
            builder.and(
              builder("tenant", "=", tenant),
              builder("id", "=", input.notificationId),
              builder("target_subject", "=", String(input.reader)),
              builder.isNull("read_at"),
            ),
          set: { read_at: now() },
        }),
      );
    });

  const resolve = (credential: VerifiedDelegatedCredential) => {
    const operation = Effect.gen(function* () {
      if (!validCredential(credential)) {
        return yield* Effect.fail(denied("invalid", "Credential reference is required."));
      }
      const rawRow = yield* db.use("delegation.grant.resolve", (query) =>
        query.findFirst("credential_delegation", {
          where: (builder) =>
            builder.and(
              builder("tenant", "=", tenant),
              builder("adapter", "=", credential.adapter),
              builder("issuer", "=", credential.issuer),
              builder("audience", "=", credential.audience),
              builder("credential_subject", "=", credential.subject),
              builder("credential_kind", "=", credential.kind),
              builder("credential_ref", "=", credential.credentialRef),
            ),
        }),
      );
      if (!rawRow) {
        const colliding = yield* db.use("delegation.grant.binding", (query) =>
          query.findFirst("credential_delegation", {
            where: (builder) => tenantWhere(builder, "credential_ref", credential.credentialRef),
          }),
        );
        if (colliding) {
          return yield* Effect.fail(denied("invalid", "Credential binding does not match."));
        }
        return yield* Effect.fail(denied("unmapped", "Credential is not delegated."));
      }
      const row = parseGrant(rawRow);
      if (!row) return yield* Effect.fail(denied("invalid", "Delegation record is invalid."));
      const revokedAt = row.revoked_at;
      if (revokedAt !== null) {
        return yield* Effect.fail(denied("revoked", "Delegation revoked."));
      }
      const expiresAt = row.expires_at;
      if (expiresAt <= now()) return yield* Effect.fail(denied("expired", "Delegation expired."));
      const scope = rowScope(row);
      if (!scope) return yield* Effect.fail(denied("invalid", "Delegation scope is invalid."));
      const grant = toGrant(api, row, scope);
      yield* checkCurrent(grant);
      yield* db.use("delegation.grant.touch", (query) =>
        query.updateMany("credential_delegation", {
          where: (builder) => tenantWhere(builder, "id", String(grant.grantId)),
          set: { last_used_at: now() },
        }),
      );
      return grant;
    });
    const credentialRecord = asRecord(credential);
    const subject = Subject.make(
      nonEmpty(credentialRecord?.subject) ? credentialRecord.subject : "unknown",
    );
    return operation.pipe(
      Effect.catchTag("DelegationDeniedError", (error) =>
        audit({
          actorSubject: subject,
          effectiveSubject: subject,
          action: "resolve",
          outcome: "denied",
        }).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
  };

  const resolveIssuedKey = (token: string) =>
    withDenialAudit(
      Effect.gen(function* () {
        // Local bearer tokens are deliberately a narrow, versioned format. A
        // provider-managed binding has no local secret and must use resolve()
        // through its adapter instead.
        if (typeof token !== "string" || token.length > 512) {
          return yield* Effect.fail(denied("invalid", "Issued key token is invalid."));
        }
        const separator = token.indexOf(".");
        if (
          separator <= 0 ||
          separator === token.length - 1 ||
          token.indexOf(".", separator + 1) !== -1
        ) {
          return yield* Effect.fail(denied("invalid", "Issued key token is invalid."));
        }
        const keyRef = token.slice(0, separator);
        const secret = token.slice(separator + 1);
        if (!/^key_[0-9a-f]{32}$/.test(keyRef) || !/^[0-9a-f]{64}$/.test(secret)) {
          return yield* Effect.fail(denied("invalid", "Issued key token is invalid."));
        }
        const rawRow = yield* db.use("delegation.issued-key.resolve", (query) =>
          query.findFirst("credential_delegation", {
            where: (builder) =>
              builder.and(
                builder("tenant", "=", tenant),
                builder("credential_kind", "=", "issued-key"),
                builder("issued_key_ref", "=", keyRef),
              ),
          }),
        );
        if (!rawRow) return yield* Effect.fail(denied("unmapped", "Issued key is not delegated."));
        const row = parseGrant(rawRow);
        if (!row || row.issued_key_ref !== keyRef || row.key_hash === null) {
          return yield* Effect.fail(denied("invalid", "Issued key binding is invalid."));
        }
        if (!/^[0-9a-f]{64}$/.test(row.key_hash)) {
          return yield* Effect.fail(denied("invalid", "Issued key binding is invalid."));
        }
        const digest = yield* sha256Hex(secret);
        if (!constantTimeHexEqual(digest, row.key_hash)) {
          return yield* Effect.fail(denied("invalid", "Issued key token is invalid."));
        }
        if (row.revoked_at !== null) {
          return yield* Effect.fail(denied("revoked", "Delegated key is revoked."));
        }
        if (row.expires_at <= now()) {
          return yield* Effect.fail(denied("expired", "Delegated key is expired."));
        }
        return yield* resolve({
          kind: "issued-key",
          adapter: row.adapter,
          issuer: row.issuer,
          audience: row.audience,
          subject: row.credential_subject,
          credentialRef: row.credential_ref,
        });
      }),
      {
        actorSubject: Subject.make("issued-key"),
        effectiveSubject: Subject.make("issued-key"),
        action: "resolve.issued-key",
        outcome: "denied",
      },
    );

  const resolveBinding = (binding: DelegationBinding) =>
    withDenialAudit(
      Effect.gen(function* () {
        if (
          String(binding.tenant) !== tenant ||
          !nonEmpty(String(binding.grantId)) ||
          !nonEmpty(String(binding.credentialId)) ||
          !nonEmpty(binding.credentialRef) ||
          !nonEmpty(String(binding.actorSubject)) ||
          !nonEmpty(String(binding.effectiveSubject)) ||
          !nonEmpty(String(binding.scopeVersion))
        ) {
          return yield* Effect.fail(denied("invalid", "Delegation binding is invalid."));
        }
        const row = yield* findGrant(binding.grantId);
        if (!row)
          return yield* Effect.fail(denied("revoked", "Delegation binding is unavailable."));
        if (
          row.tenant !== tenant ||
          row.credential_id !== String(binding.credentialId) ||
          row.credential_ref !== binding.credentialRef ||
          row.actor_subject !== String(binding.actorSubject) ||
          row.effective_subject !== String(binding.effectiveSubject)
        ) {
          return yield* Effect.fail(denied("unauthorized", "Delegation binding does not match."));
        }
        if (row.scope_version !== String(binding.scopeVersion)) {
          return yield* Effect.fail(denied("scope", "Delegation scope changed."));
        }
        if (row.revoked_at !== null)
          return yield* Effect.fail(denied("revoked", "Delegation revoked."));
        if (row.expires_at <= now())
          return yield* Effect.fail(denied("expired", "Delegation expired."));
        const scope = rowScope(row);
        if (!scope) return yield* Effect.fail(invalidStoredRow("credential_delegation"));
        const grant = toGrant(api, row, scope);
        yield* checkCurrent(grant);
        yield* audit({
          grantId: grant.grantId,
          credentialId: grant.credentialId,
          actorSubject: grant.actorSubject,
          effectiveSubject: grant.effectiveSubject,
          action: "resolve.binding",
          outcome: "allowed",
        });
        return grant;
      }),
      {
        actorSubject: binding.actorSubject,
        effectiveSubject: binding.effectiveSubject,
        action: "resolve.binding",
        outcome: "denied",
      },
    );

  const revalidate = (context: DelegationContext, capability: DelegationCapability) => {
    const operation = Effect.gen(function* () {
      const row = yield* findGrant(context.grantId);
      if (!row) return yield* Effect.fail(denied("revoked", "Delegation grant is unavailable."));
      if (
        row.tenant !== tenant ||
        String(context.tenant) !== row.tenant ||
        row.credential_id !== String(context.credentialId) ||
        row.credential_ref !== context.credentialRef ||
        row.actor_subject !== String(context.actorSubject) ||
        row.effective_subject !== String(context.effectiveSubject)
      ) {
        return yield* Effect.fail(denied("unauthorized", "Delegation context does not match."));
      }
      const revokedAt = row.revoked_at;
      if (revokedAt !== null) return yield* Effect.fail(denied("revoked", "Delegation revoked."));
      if (row.expires_at <= now())
        return yield* Effect.fail(denied("expired", "Delegation expired."));
      const scope = rowScope(row);
      if (!scope || String(row.scope_version) !== String(context.scopeVersion)) {
        return yield* Effect.fail(denied("scope", "Delegation scope changed."));
      }
      const current = toGrant(api, row, scope);
      yield* checkCurrent(current);
      if (capability.operation === "management") {
        return yield* Effect.fail(
          denied("management", "Delegated credentials cannot manage accounts or connections."),
        );
      }
      const requiredAction: DelegationScopeAction =
        capability.operation === "catalog" || capability.operation === "schema"
          ? "discover"
          : "invoke";
      if (!scope.actions.includes(requiredAction)) {
        return yield* Effect.fail(
          denied("scope", "Delegation action is outside the consented scope."),
        );
      }
      if (
        capability.tool &&
        !scope.toolAddresses.some((tool) => String(tool) === String(capability.tool))
      ) {
        return yield* Effect.fail(denied("scope", "Tool is outside the delegated snapshot."));
      }
      if (capability.connection) {
        const toolkitConnections = scope.toolkitMembership.flatMap((toolkit) =>
          toolkit.connectionAddresses.map(String),
        );
        const allowedConnections =
          scope.connectionAddresses === undefined
            ? toolkitConnections
            : scope.connectionAddresses.map(String);
        if (!allowedConnections.includes(String(capability.connection))) {
          return yield* Effect.fail(
            denied("scope", "Connection is outside the delegated allowlist."),
          );
        }
      }
      yield* audit({
        grantId: context.grantId,
        credentialId: context.credentialId,
        actorSubject: context.actorSubject,
        effectiveSubject: context.effectiveSubject,
        action: capability.operation,
        tool: capability.tool,
        outcome: "allowed",
        requestId: capability.requestId,
        executionId: capability.executionId,
      });
    });
    return operation.pipe(
      Effect.catchTag("DelegationDeniedError", (error) =>
        audit({
          grantId: context.grantId,
          credentialId: context.credentialId,
          actorSubject: context.actorSubject,
          effectiveSubject: context.effectiveSubject,
          action: capability.operation,
          tool: capability.tool,
          outcome: "denied",
          requestId: capability.requestId,
          executionId: capability.executionId,
        }).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
  };

  const create = (input: CreateDelegationInput) =>
    withDenialAudit(
      Effect.gen(function* () {
        if (!options.issuanceEnabled)
          return yield* Effect.fail(
            denied("management", "Delegated credential issuance is disabled."),
          );
        const maxTtlMs = options.maxTtlMs ?? MAX_DELEGATION_TTL_MS;
        if (!validMaxTtl(maxTtlMs)) {
          return yield* Effect.fail(denied("invalid", "Delegation maximum TTL is invalid."));
        }
        const rawChallenge = yield* db.use("delegation.challenge.consent", (query) =>
          query.findFirst("delegation_challenge", {
            where: (builder) => tenantWhere(builder, "id", input.proofChallengeId),
          }),
        );
        const proven = rawChallenge ? parseChallenge(rawChallenge) : null;
        if (!proven) return yield* Effect.fail(denied("proof", "Proof challenge is invalid."));
        if (proven.consent_consumed_at !== null || proven.proof_consumed_at === null) {
          return yield* Effect.fail(denied("proof", "Proof challenge is not ready for consent."));
        }
        const scope = rowScope(proven);
        if (!scope) return yield* Effect.fail(denied("scope", "Consent scope is invalid."));
        const issuedAt = now();
        const expiresAt = proven.grant_expires_at;
        if (!validTtlWindow(issuedAt, expiresAt, maxTtlMs)) {
          return yield* Effect.fail(
            denied("invalid", "Delegation expiry is outside the allowed window."),
          );
        }
        if (!(yield* options.isVerifiedHuman(input.consentedBy))) {
          return yield* Effect.fail(
            denied("unauthorized", "Grant consenter is not a verified human."),
          );
        }
        if (String(input.consentedBy) !== proven.created_by) {
          return yield* Effect.fail(
            denied("unauthorized", "Only the challenge creator may give consent."),
          );
        }
        const effectiveSubject = Subject.make(proven.effective_subject);
        if (!(yield* options.isManagementAuthorized(input.consentedBy, effectiveSubject))) {
          return yield* Effect.fail(denied("unauthorized", "Grant consenter is not authorized."));
        }
        if (!(yield* options.isVerifiedHuman(effectiveSubject))) {
          return yield* Effect.fail(denied("unauthorized", "Target must be a verified human."));
        }
        if (
          proven.credential_kind === null ||
          proven.issuer === null ||
          proven.audience === null ||
          proven.credential_subject === null ||
          proven.credential_ref === null ||
          proven.actor_subject === null
        ) {
          return yield* Effect.fail(denied("proof", "Proof challenge has no proven credential."));
        }
        const credential: VerifiedDelegatedCredential = {
          kind: proven.credential_kind === "issued-key" ? "issued-key" : "external",
          adapter: proven.adapter,
          issuer: proven.issuer,
          audience: proven.audience,
          subject: proven.credential_subject,
          credentialRef: proven.credential_ref,
        };
        if (!validCredential(credential)) {
          return yield* Effect.fail(denied("proof", "Proven credential tuple is invalid."));
        }
        const actorSubject = Subject.make(proven.actor_subject);
        const grantId = DelegationId.make(`grant_${randomHex(16)}`);
        const credentialId = CredentialId.make(`cred_${randomHex(16)}`);
        if (!validScopeVersion(input.scopeVersion)) {
          return yield* Effect.fail(denied("invalid", "Delegation scope version is invalid."));
        }
        const scopeVersion =
          input.scopeVersion ?? DelegationScopeVersion.make(`scope_${randomHex(16)}`);
        if (!validEpoch(expiresAt) || expiresAt <= issuedAt) {
          return yield* Effect.fail(
            denied("invalid", "Delegation expiry must be in the allowed window."),
          );
        }
        yield* db.transaction(
          Effect.gen(function* () {
            yield* claimChallengePhase({
              challengeId: input.proofChallengeId,
              phase: "consent",
              actorSubject: input.consentedBy,
              effectiveSubject,
            }).pipe(
              Effect.catchTag("UniqueViolationError", () =>
                Effect.fail(denied("proof", "Proof challenge consent has already been used.")),
              ),
            );
            yield* db.use("delegation.challenge.consent.consume", (query) =>
              query.updateMany("delegation_challenge", {
                where: (builder) =>
                  builder.and(
                    builder("tenant", "=", tenant),
                    builder("id", "=", input.proofChallengeId),
                    builder.isNull("consent_consumed_at"),
                  ),
                set: { consent_consumed_at: issuedAt, credential_id: String(credentialId) },
              }),
            );
            const claimedRaw = yield* db.use("delegation.challenge.consent.verify", (query) =>
              query.findFirst("delegation_challenge", {
                where: (builder) => tenantWhere(builder, "id", input.proofChallengeId),
              }),
            );
            const claimed = claimedRaw ? parseChallenge(claimedRaw) : null;
            if (
              !claimed ||
              claimed.consent_consumed_at === null ||
              claimed.credential_id !== String(credentialId)
            ) {
              return yield* Effect.fail(
                denied("proof", "Proof challenge consent could not be claimed."),
              );
            }
            yield* db
              .use("delegation.grant.create", (query) =>
                query.create("credential_delegation", {
                  tenant,
                  id: String(grantId),
                  label: proven.label,
                  created_by: proven.created_by,
                  credential_id: String(credentialId),
                  credential_kind: credential.kind,
                  adapter: credential.adapter,
                  issuer: credential.issuer,
                  audience: credential.audience,
                  credential_subject: credential.subject,
                  credential_ref: credential.credentialRef,
                  issued_key_ref:
                    credential.kind === "issued-key" ? credential.credentialRef : null,
                  key_hash: null,
                  actor_subject: String(actorSubject),
                  effective_subject: String(effectiveSubject),
                  toolkit_membership: encodeScope({
                    actions: ["discover", "invoke"],
                    toolkitMembership: scope.toolkitMembership,
                    toolAddresses: [],
                    connectionAddresses: [],
                  }),
                  scope: encodeScope(scope),
                  scope_version: String(scopeVersion),
                  expires_at: expiresAt,
                  revoked_at: null,
                  revoke_reason: null,
                  created_at: nowDate(issuedAt),
                  last_used_at: null,
                }),
              )
              .pipe(
                Effect.catchTag("UniqueViolationError", () =>
                  Effect.fail(denied("invalid", "Credential is already bound to a delegation.")),
                ),
              );
            yield* audit({
              grantId,
              credentialId,
              actorSubject: input.consentedBy,
              effectiveSubject,
              action: "grant.create",
              outcome: "created",
            });
            yield* createNotification({
              grantId,
              credentialId,
              createdBy: Subject.make(proven.created_by),
              targetSubject: effectiveSubject,
              label: proven.label,
              credentialKind: credential.kind,
            });
          }),
        );
        const grant: DelegationGrant = {
          kind: "delegated",
          tenant: options.tenant,
          grantId,
          credentialId,
          credentialRef: credential.credentialRef,
          actorSubject,
          effectiveSubject,
          scopeVersion,
          expiresAt,
          scope,
          revalidate: (capability) => api.revalidate(grant, capability),
        };
        return grant;
      }),
      {
        actorSubject: input.consentedBy,
        effectiveSubject: input.consentedBy,
        action: "grant.create",
        outcome: "denied",
      },
    );

  const createIssuedKey = (input: CreateIssuedDelegationInput) =>
    withDenialAudit(
      Effect.gen(function* () {
        if (!options.issuanceEnabled) {
          return yield* Effect.fail(
            denied("management", "Delegated credential issuance is disabled."),
          );
        }
        if (!nonEmpty(input.label)) {
          return yield* Effect.fail(denied("invalid", "Delegated key label is required."));
        }
        const scope = normalizeScope(input.scope);
        if (!scope) return yield* Effect.fail(denied("invalid", "Key scope is invalid."));
        const issuedAt = now();
        const maxTtlMs = options.maxTtlMs ?? MAX_DELEGATION_TTL_MS;
        const expiresAt =
          input.expiresAt ?? issuedAt + Math.min(DEFAULT_DELEGATION_TTL_MS, maxTtlMs);
        if (!validTtlWindow(issuedAt, expiresAt, maxTtlMs)) {
          return yield* Effect.fail(
            denied("invalid", "Delegation expiry is outside the allowed window."),
          );
        }
        if (!(yield* options.isVerifiedHuman(input.createdBy))) {
          return yield* Effect.fail(denied("unauthorized", "Key creator is not a verified human."));
        }
        if (!(yield* options.isVerifiedHuman(input.effectiveSubject))) {
          return yield* Effect.fail(denied("unauthorized", "Key target is not a verified human."));
        }
        if (!(yield* options.isManagementAuthorized(input.createdBy, input.effectiveSubject))) {
          return yield* Effect.fail(denied("unauthorized", "Key creator is not authorized."));
        }
        const adapter = input.adapter ?? "executor";
        const issuer = input.issuer ?? "executor";
        const audience = input.audience ?? "delegated";
        if (![adapter, issuer, audience].every(nonEmpty)) {
          return yield* Effect.fail(denied("invalid", "Issued key binding is invalid."));
        }
        const generated = yield* generateDelegatedKey();
        const keyRef = `key_${randomHex(16)}`;
        const credential: VerifiedDelegatedCredential = {
          kind: "issued-key",
          adapter,
          issuer,
          audience,
          subject: keyRef,
          credentialRef: keyRef,
        };
        const actorSubject = Subject.make(`issued:${keyRef}`);
        const grantId = DelegationId.make(`grant_${randomHex(16)}`);
        const credentialId = CredentialId.make(`cred_${randomHex(16)}`);
        if (!validScopeVersion(input.scopeVersion)) {
          return yield* Effect.fail(denied("invalid", "Delegation scope version is invalid."));
        }
        const scopeVersion =
          input.scopeVersion ?? DelegationScopeVersion.make(`scope_${randomHex(16)}`);
        yield* db.transaction(
          Effect.gen(function* () {
            yield* db.use("delegation.issued-key.create", (query) =>
              query.create("credential_delegation", {
                tenant,
                id: String(grantId),
                label: input.label,
                created_by: String(input.createdBy),
                credential_id: String(credentialId),
                credential_kind: credential.kind,
                adapter: credential.adapter,
                issuer: credential.issuer,
                audience: credential.audience,
                credential_subject: credential.subject,
                credential_ref: credential.credentialRef,
                issued_key_ref: keyRef,
                key_hash: generated.hash,
                actor_subject: String(actorSubject),
                effective_subject: String(input.effectiveSubject),
                toolkit_membership: encodeScope({
                  actions: ["discover", "invoke"],
                  toolkitMembership: scope.toolkitMembership,
                  toolAddresses: [],
                  connectionAddresses: [],
                }),
                scope: encodeScope(scope),
                scope_version: String(scopeVersion),
                expires_at: expiresAt,
                revoked_at: null,
                revoke_reason: null,
                created_at: nowDate(issuedAt),
                last_used_at: null,
              }),
            );
            yield* audit({
              grantId,
              credentialId,
              actorSubject: input.createdBy,
              effectiveSubject: input.effectiveSubject,
              action: "grant.create.issued-key",
              outcome: "created",
            });
            yield* createNotification({
              grantId,
              credentialId,
              createdBy: input.createdBy,
              targetSubject: input.effectiveSubject,
              label: input.label,
              credentialKind: credential.kind,
            });
          }),
        );
        const grant: DelegationGrant = {
          kind: "delegated",
          tenant: options.tenant,
          grantId,
          credentialId,
          credentialRef: credential.credentialRef,
          actorSubject,
          effectiveSubject: input.effectiveSubject,
          scopeVersion,
          expiresAt,
          scope,
          revalidate: (capability) => api.revalidate(grant, capability),
        };
        return {
          keyRef,
          secret: `${keyRef}.${generated.secret}`,
          grant,
        } satisfies IssuedDelegationKey;
      }),
      {
        actorSubject: input.createdBy,
        effectiveSubject: input.effectiveSubject,
        action: "grant.create.issued-key",
        outcome: "denied",
      },
    );

  const rotateIssuedKey = (input: RotateIssuedDelegationInput) =>
    withDenialAudit(
      Effect.gen(function* () {
        if (!options.issuanceEnabled) {
          return yield* Effect.fail(
            denied("management", "Delegated credential issuance is disabled."),
          );
        }
        const row = yield* db
          .use("delegation.issued-key.rotate.get", (query) =>
            query.findFirst("credential_delegation", {
              where: (builder) => tenantWhere(builder, "credential_id", String(input.credentialId)),
            }),
          )
          .pipe(Effect.map(parseGrant));
        if (!row) return yield* Effect.fail(denied("invalid", "Delegated key not found."));
        if (
          row.credential_kind !== "issued-key" ||
          row.issued_key_ref === null ||
          row.key_hash === null
        ) {
          return yield* Effect.fail(denied("invalid", "Only local issued keys can rotate."));
        }
        if (row.revoked_at !== null) {
          return yield* Effect.fail(denied("revoked", "Delegated key is revoked."));
        }
        if (row.expires_at <= now()) {
          return yield* Effect.fail(denied("expired", "Delegated key is expired."));
        }
        const target = Subject.make(row.effective_subject);
        if (!(yield* options.isVerifiedHuman(input.actorSubject))) {
          return yield* Effect.fail(denied("unauthorized", "Key rotator is not a verified human."));
        }
        if (!(yield* options.isManagementAuthorized(input.actorSubject, target))) {
          return yield* Effect.fail(denied("unauthorized", "Key rotator is not authorized."));
        }
        const scope = rowScope(row);
        if (!scope) return yield* Effect.fail(invalidStoredRow("credential_delegation"));
        const generated = yield* generateDelegatedKey();
        const keyRef = `key_${randomHex(16)}`;
        const credential: VerifiedDelegatedCredential = {
          kind: "issued-key",
          adapter: row.adapter,
          issuer: row.issuer,
          audience: row.audience,
          subject: keyRef,
          credentialRef: keyRef,
        };
        const actorSubject = Subject.make(`issued:${keyRef}`);
        const grantId = DelegationId.make(`grant_${randomHex(16)}`);
        const credentialId = CredentialId.make(`cred_${randomHex(16)}`);
        const scopeVersion = DelegationScopeVersion.make(`scope_${randomHex(16)}`);
        const at = now();
        const maxTtlMs = options.maxTtlMs ?? MAX_DELEGATION_TTL_MS;
        const expiresAt = Math.min(row.expires_at, at + maxTtlMs);
        if (!validTtlWindow(at, expiresAt, maxTtlMs)) {
          return yield* Effect.fail(
            denied("invalid", "Delegation expiry is outside the allowed window."),
          );
        }
        yield* db.transaction(
          Effect.gen(function* () {
            // Claim the old binding before changing it. Fuma's updateMany does
            // not return an affected-row count, so a deterministic unique claim
            // is the portable single-use guard for concurrent rotations.
            yield* claimOperation({
              claimId: `delegation_claim_rotate_${row.id}`,
              action: "grant.rotate.claim",
              actorSubject: input.actorSubject,
              effectiveSubject: target,
            }).pipe(
              Effect.catchTag("UniqueViolationError", () =>
                Effect.fail(denied("revoked", "Delegated key rotation has already been used.")),
              ),
            );
            // Keep the old row as a revocation tombstone. The conditional update
            // means a stale concurrent rotation cannot silently revive it.
            yield* db.use("delegation.issued-key.rotate.revoke", (query) =>
              query.updateMany("credential_delegation", {
                where: (builder) =>
                  builder.and(
                    builder("tenant", "=", tenant),
                    builder("id", "=", row.id),
                    builder.isNull("revoked_at"),
                  ),
                set: { revoked_at: at, revoke_reason: "rotated" },
              }),
            );
            yield* db.use("delegation.issued-key.rotate.create", (query) =>
              query.create("credential_delegation", {
                tenant,
                id: String(grantId),
                label: row.label,
                created_by: row.created_by,
                credential_id: String(credentialId),
                credential_kind: credential.kind,
                adapter: credential.adapter,
                issuer: credential.issuer,
                audience: credential.audience,
                credential_subject: credential.subject,
                credential_ref: credential.credentialRef,
                issued_key_ref: keyRef,
                key_hash: generated.hash,
                actor_subject: String(actorSubject),
                effective_subject: row.effective_subject,
                toolkit_membership: encodeScope({
                  actions: ["discover", "invoke"],
                  toolkitMembership: scope.toolkitMembership,
                  toolAddresses: [],
                  connectionAddresses: [],
                }),
                scope: encodeScope(scope),
                scope_version: String(scopeVersion),
                expires_at: expiresAt,
                revoked_at: null,
                revoke_reason: null,
                created_at: nowDate(at),
                last_used_at: null,
              }),
            );
            yield* audit({
              grantId: DelegationId.make(row.id),
              credentialId: CredentialId.make(row.credential_id),
              actorSubject: input.actorSubject,
              effectiveSubject: target,
              action: "grant.rotate.revoke",
              outcome: "revoked",
            });
            yield* audit({
              grantId,
              credentialId,
              actorSubject: input.actorSubject,
              effectiveSubject: target,
              action: "grant.rotate.create",
              outcome: "created",
            });
            yield* createNotification({
              grantId,
              credentialId,
              createdBy: Subject.make(row.created_by),
              targetSubject: target,
              label: row.label,
              credentialKind: credential.kind,
            });
          }),
        );
        const grant: DelegationGrant = {
          kind: "delegated",
          tenant: options.tenant,
          grantId,
          credentialId,
          credentialRef: credential.credentialRef,
          actorSubject,
          effectiveSubject: target,
          scopeVersion,
          expiresAt,
          scope,
          revalidate: (capability) => api.revalidate(grant, capability),
        };
        return {
          keyRef,
          secret: `${keyRef}.${generated.secret}`,
          grant,
        } satisfies IssuedDelegationKey;
      }),
      {
        actorSubject: input.actorSubject,
        effectiveSubject: input.actorSubject,
        action: "grant.rotate",
        outcome: "denied",
      },
    );

  const registerProviderIssuedKey = (input: RegisterProviderIssuedDelegationInput) =>
    withDenialAudit(
      Effect.gen(function* () {
        if (!options.issuanceEnabled) {
          return yield* Effect.fail(
            denied("management", "Delegated credential issuance is disabled."),
          );
        }
        if (!nonEmpty(input.label) || !validCredential(input.credential)) {
          return yield* Effect.fail(denied("invalid", "Provider key binding is invalid."));
        }
        if (input.credential.kind !== "issued-key" || !nonEmpty(String(input.actorSubject))) {
          return yield* Effect.fail(denied("invalid", "Provider key binding is invalid."));
        }
        const scope = normalizeScope(input.scope);
        if (!scope) return yield* Effect.fail(denied("invalid", "Key scope is invalid."));
        const issuedAt = now();
        const maxTtlMs = options.maxTtlMs ?? MAX_DELEGATION_TTL_MS;
        const expiresAt =
          input.expiresAt ?? issuedAt + Math.min(DEFAULT_DELEGATION_TTL_MS, maxTtlMs);
        if (!validTtlWindow(issuedAt, expiresAt, maxTtlMs)) {
          return yield* Effect.fail(
            denied("invalid", "Delegation expiry is outside the allowed window."),
          );
        }
        if (!(yield* options.isVerifiedHuman(input.createdBy))) {
          return yield* Effect.fail(denied("unauthorized", "Key creator is not a verified human."));
        }
        if (!(yield* options.isVerifiedHuman(input.effectiveSubject))) {
          return yield* Effect.fail(denied("unauthorized", "Key target is not a verified human."));
        }
        if (!(yield* options.isManagementAuthorized(input.createdBy, input.effectiveSubject))) {
          return yield* Effect.fail(denied("unauthorized", "Key creator is not authorized."));
        }
        const verifyProviderCredential = options.verifyProviderCredential;
        if (verifyProviderCredential === undefined) {
          return yield* Effect.fail(
            denied("unauthorized", "Provider key verification is unavailable."),
          );
        }
        if (
          !(yield* verifyProviderCredential({
            credential: input.credential,
            actorSubject: input.actorSubject,
            effectiveSubject: input.effectiveSubject,
          }))
        ) {
          return yield* Effect.fail(denied("unauthorized", "Provider key is not authorized."));
        }
        const grantId = DelegationId.make(`grant_${randomHex(16)}`);
        const credentialId = CredentialId.make(`cred_${randomHex(16)}`);
        if (!validScopeVersion(input.scopeVersion)) {
          return yield* Effect.fail(denied("invalid", "Delegation scope version is invalid."));
        }
        const scopeVersion =
          input.scopeVersion ?? DelegationScopeVersion.make(`scope_${randomHex(16)}`);
        yield* db
          .transaction(
            Effect.gen(function* () {
              yield* db.use("delegation.provider-key.create", (query) =>
                query.create("credential_delegation", {
                  tenant,
                  id: String(grantId),
                  label: input.label,
                  created_by: String(input.createdBy),
                  credential_id: String(credentialId),
                  credential_kind: input.credential.kind,
                  adapter: input.credential.adapter,
                  issuer: input.credential.issuer,
                  audience: input.credential.audience,
                  credential_subject: input.credential.subject,
                  credential_ref: input.credential.credentialRef,
                  issued_key_ref: input.credential.credentialRef,
                  // Provider verification happens at the adapter boundary;
                  // core must never manufacture or persist a provider secret.
                  key_hash: null,
                  actor_subject: String(input.actorSubject),
                  effective_subject: String(input.effectiveSubject),
                  toolkit_membership: encodeScope({
                    actions: ["discover", "invoke"],
                    toolkitMembership: scope.toolkitMembership,
                    toolAddresses: [],
                    connectionAddresses: [],
                  }),
                  scope: encodeScope(scope),
                  scope_version: String(scopeVersion),
                  expires_at: expiresAt,
                  revoked_at: null,
                  revoke_reason: null,
                  created_at: nowDate(issuedAt),
                  last_used_at: null,
                }),
              );
              yield* audit({
                grantId,
                credentialId,
                actorSubject: input.createdBy,
                effectiveSubject: input.effectiveSubject,
                action: "grant.create.provider-key",
                outcome: "created",
              });
              yield* createNotification({
                grantId,
                credentialId,
                createdBy: input.createdBy,
                targetSubject: input.effectiveSubject,
                label: input.label,
                credentialKind: input.credential.kind,
              });
            }),
          )
          .pipe(
            Effect.catchTag("UniqueViolationError", () =>
              Effect.fail(denied("invalid", "Credential is already bound to a delegation.")),
            ),
          );
        const grant: DelegationGrant = {
          kind: "delegated",
          tenant: options.tenant,
          grantId,
          credentialId,
          credentialRef: input.credential.credentialRef,
          actorSubject: input.actorSubject,
          effectiveSubject: input.effectiveSubject,
          scopeVersion,
          expiresAt,
          scope,
          revalidate: (capability) => api.revalidate(grant, capability),
        };
        return grant;
      }),
      {
        actorSubject: input.createdBy,
        effectiveSubject: input.effectiveSubject,
        action: "grant.create.provider-key",
        outcome: "denied",
      },
    );

  const rotateProviderIssuedKey = (input: RotateProviderIssuedDelegationInput) =>
    withDenialAudit(
      Effect.gen(function* () {
        if (!options.issuanceEnabled) {
          return yield* Effect.fail(
            denied("management", "Delegated credential issuance is disabled."),
          );
        }
        if (!validCredential(input.credential) || input.credential.kind !== "issued-key") {
          return yield* Effect.fail(denied("invalid", "Provider key binding is invalid."));
        }
        if (!nonEmpty(String(input.actorSubject))) {
          return yield* Effect.fail(denied("invalid", "Provider key actor is invalid."));
        }
        const row = yield* db
          .use("delegation.provider-key.rotate.get", (query) =>
            query.findFirst("credential_delegation", {
              where: (builder) => tenantWhere(builder, "credential_id", String(input.credentialId)),
            }),
          )
          .pipe(Effect.map(parseGrant));
        if (!row) return yield* Effect.fail(denied("invalid", "Delegated key not found."));
        if (
          row.credential_kind !== "issued-key" ||
          row.issued_key_ref === null ||
          row.key_hash !== null
        ) {
          return yield* Effect.fail(denied("invalid", "Only provider-issued keys can rotate."));
        }
        if (row.revoked_at !== null) {
          return yield* Effect.fail(denied("revoked", "Delegated key is revoked."));
        }
        const at = now();
        if (row.expires_at <= at) {
          return yield* Effect.fail(denied("expired", "Delegated key is expired."));
        }
        const target = Subject.make(row.effective_subject);
        if (!(yield* options.isVerifiedHuman(input.managedBy))) {
          return yield* Effect.fail(denied("unauthorized", "Key rotator is not a verified human."));
        }
        if (!(yield* options.isManagementAuthorized(input.managedBy, target))) {
          return yield* Effect.fail(denied("unauthorized", "Key rotator is not authorized."));
        }
        const verifyProviderCredential = options.verifyProviderCredential;
        if (verifyProviderCredential === undefined) {
          return yield* Effect.fail(
            denied("unauthorized", "Provider key verification is unavailable."),
          );
        }
        if (
          !(yield* verifyProviderCredential({
            credential: input.credential,
            actorSubject: input.actorSubject,
            effectiveSubject: target,
          }))
        ) {
          return yield* Effect.fail(denied("unauthorized", "Provider key is not authorized."));
        }
        const scope = rowScope(row);
        if (!scope) return yield* Effect.fail(invalidStoredRow("credential_delegation"));
        const maxTtlMs = options.maxTtlMs ?? MAX_DELEGATION_TTL_MS;
        const expiresAt = input.expiresAt ?? Math.min(row.expires_at, at + maxTtlMs);
        if (!validTtlWindow(at, expiresAt, maxTtlMs)) {
          return yield* Effect.fail(
            denied("invalid", "Delegation expiry is outside the allowed window."),
          );
        }
        const grantId = DelegationId.make(`grant_${randomHex(16)}`);
        const credentialId = CredentialId.make(`cred_${randomHex(16)}`);
        if (!validScopeVersion(input.scopeVersion)) {
          return yield* Effect.fail(denied("invalid", "Delegation scope version is invalid."));
        }
        const scopeVersion =
          input.scopeVersion ?? DelegationScopeVersion.make(`scope_${randomHex(16)}`);
        yield* db
          .transaction(
            Effect.gen(function* () {
              yield* claimOperation({
                claimId: `delegation_claim_rotate_${row.id}`,
                action: "grant.rotate.claim",
                actorSubject: input.managedBy,
                effectiveSubject: target,
              }).pipe(
                Effect.catchTag("UniqueViolationError", () =>
                  Effect.fail(denied("revoked", "Delegated key rotation has already been used.")),
                ),
              );
              yield* db.use("delegation.provider-key.rotate.revoke", (query) =>
                query.updateMany("credential_delegation", {
                  where: (builder) =>
                    builder.and(
                      builder("tenant", "=", tenant),
                      builder("id", "=", row.id),
                      builder.isNull("revoked_at"),
                    ),
                  set: { revoked_at: at, revoke_reason: "rotated" },
                }),
              );
              yield* db.use("delegation.provider-key.rotate.create", (query) =>
                query.create("credential_delegation", {
                  tenant,
                  id: String(grantId),
                  label: row.label,
                  created_by: row.created_by,
                  credential_id: String(credentialId),
                  credential_kind: input.credential.kind,
                  adapter: input.credential.adapter,
                  issuer: input.credential.issuer,
                  audience: input.credential.audience,
                  credential_subject: input.credential.subject,
                  credential_ref: input.credential.credentialRef,
                  issued_key_ref: input.credential.credentialRef,
                  key_hash: null,
                  actor_subject: String(input.actorSubject),
                  effective_subject: row.effective_subject,
                  toolkit_membership: encodeScope({
                    actions: ["discover", "invoke"],
                    toolkitMembership: scope.toolkitMembership,
                    toolAddresses: [],
                    connectionAddresses: [],
                  }),
                  scope: encodeScope(scope),
                  scope_version: String(scopeVersion),
                  expires_at: expiresAt,
                  revoked_at: null,
                  revoke_reason: null,
                  created_at: nowDate(at),
                  last_used_at: null,
                }),
              );
              yield* audit({
                grantId: DelegationId.make(row.id),
                credentialId: CredentialId.make(row.credential_id),
                actorSubject: input.managedBy,
                effectiveSubject: target,
                action: "grant.rotate.revoke",
                outcome: "revoked",
              });
              yield* audit({
                grantId,
                credentialId,
                actorSubject: input.managedBy,
                effectiveSubject: target,
                action: "grant.rotate.create.provider-key",
                outcome: "created",
              });
              yield* createNotification({
                grantId,
                credentialId,
                createdBy: Subject.make(row.created_by),
                targetSubject: target,
                label: row.label,
                credentialKind: input.credential.kind,
              });
            }),
          )
          .pipe(
            Effect.catchTag("UniqueViolationError", () =>
              Effect.fail(denied("invalid", "Credential is already bound to a delegation.")),
            ),
          );
        const grant: DelegationGrant = {
          kind: "delegated",
          tenant: options.tenant,
          grantId,
          credentialId,
          credentialRef: input.credential.credentialRef,
          actorSubject: input.actorSubject,
          effectiveSubject: target,
          scopeVersion,
          expiresAt,
          scope,
          revalidate: (capability) => api.revalidate(grant, capability),
        };
        return grant;
      }),
      {
        actorSubject: input.managedBy,
        effectiveSubject: input.managedBy,
        action: "grant.rotate.provider-key",
        outcome: "denied",
      },
    );

  const expand = (input: ExpandDelegationInput) =>
    withDenialAudit(
      Effect.gen(function* () {
        if (!options.issuanceEnabled) {
          return yield* Effect.fail(
            denied("management", "Delegated credential issuance is disabled."),
          );
        }
        const row = yield* db
          .use("delegation.grant.expand.get", (query) =>
            query.findFirst("credential_delegation", {
              where: (builder) => tenantWhere(builder, "credential_id", String(input.credentialId)),
            }),
          )
          .pipe(Effect.map(parseGrant));
        if (!row) return yield* Effect.fail(denied("invalid", "Delegation grant not found."));
        if (row.revoked_at !== null)
          return yield* Effect.fail(denied("revoked", "Delegation revoked."));
        const at = now();
        if (row.expires_at <= at)
          return yield* Effect.fail(denied("expired", "Delegation expired."));
        if (!validEpoch(input.expiresAt) || input.expiresAt <= at) {
          return yield* Effect.fail(denied("invalid", "Delegation expiry is invalid."));
        }
        const maxTtlMs = options.maxTtlMs ?? MAX_DELEGATION_TTL_MS;
        if (!validTtlWindow(at, input.expiresAt, maxTtlMs)) {
          return yield* Effect.fail(
            denied("invalid", "Delegation expiry is outside the allowed window."),
          );
        }
        const previous = rowScope(row);
        const next = normalizeScope(input.scope);
        if (!previous || !next) {
          return yield* Effect.fail(denied("scope", "Delegation scope is invalid."));
        }
        if (!isScopeExpansion(previous, next)) {
          return yield* Effect.fail(
            denied("scope", "Delegation scope may only expand with consent."),
          );
        }
        const target = Subject.make(row.effective_subject);
        if (!(yield* options.isVerifiedHuman(input.consentedBy))) {
          return yield* Effect.fail(
            denied("unauthorized", "Grant consenter is not a verified human."),
          );
        }
        if (!(yield* options.isVerifiedHuman(target))) {
          return yield* Effect.fail(
            denied("unauthorized", "Delegated subject is no longer authorized."),
          );
        }
        if (!(yield* options.isManagementAuthorized(input.consentedBy, target))) {
          return yield* Effect.fail(denied("unauthorized", "Grant consenter is not authorized."));
        }
        if (
          input.expectedScopeVersion !== undefined &&
          String(input.expectedScopeVersion) !== row.scope_version
        ) {
          return yield* Effect.fail(denied("scope", "Delegation scope changed before consent."));
        }
        if (!validScopeVersion(input.scopeVersion)) {
          return yield* Effect.fail(denied("invalid", "Delegation scope version is invalid."));
        }
        const scopeVersion =
          input.scopeVersion ?? DelegationScopeVersion.make(`scope_${randomHex(16)}`);
        yield* db.transaction(
          Effect.gen(function* () {
            yield* db.use("delegation.grant.expand", (query) =>
              query.updateMany("credential_delegation", {
                where: (builder) =>
                  builder.and(
                    builder("tenant", "=", tenant),
                    builder("credential_id", "=", String(input.credentialId)),
                    builder("scope_version", "=", row.scope_version),
                    builder.isNull("revoked_at"),
                  ),
                set: {
                  scope: encodeScope(next),
                  toolkit_membership: encodeScope({
                    actions: ["discover", "invoke"],
                    toolkitMembership: next.toolkitMembership,
                    toolAddresses: [],
                    connectionAddresses: [],
                  }),
                  scope_version: String(scopeVersion),
                  expires_at: input.expiresAt,
                },
              }),
            );
            yield* audit({
              grantId: DelegationId.make(row.id),
              credentialId: input.credentialId,
              actorSubject: input.consentedBy,
              effectiveSubject: target,
              action: "grant.expand",
              outcome: "changed",
            });
          }),
        );
        const grant = toGrant(
          api,
          {
            ...row,
            scope: encodeScope(next),
            scope_version: String(scopeVersion),
            expires_at: input.expiresAt,
          },
          next,
        );
        return grant;
      }),
      {
        actorSubject: input.consentedBy,
        effectiveSubject: input.consentedBy,
        action: "grant.expand",
        outcome: "denied",
      },
    );

  const revoke = (input: {
    readonly grantId: DelegationId;
    readonly actorSubject: Subject;
    readonly reason?: string;
  }) =>
    withDenialAudit(
      Effect.gen(function* () {
        const row = yield* findGrant(input.grantId);
        if (!row) return yield* Effect.fail(denied("invalid", "Delegation grant not found."));
        if (row.revoked_at !== null) {
          return yield* Effect.fail(denied("revoked", "Delegation already revoked."));
        }
        if (!(yield* options.isVerifiedHuman(input.actorSubject))) {
          return yield* Effect.fail(denied("unauthorized", "Revoker is not a verified human."));
        }
        if (
          !(yield* options.isManagementAuthorized(
            input.actorSubject,
            Subject.make(row.effective_subject),
          ))
        ) {
          return yield* Effect.fail(denied("unauthorized", "Revoker is not authorized."));
        }
        const at = now();
        yield* db.transaction(
          Effect.gen(function* () {
            yield* db.use("delegation.grant.revoke", (query) =>
              query.updateMany("credential_delegation", {
                where: (builder) =>
                  builder.and(
                    tenantWhere(builder, "id", String(input.grantId)),
                    builder.isNull("revoked_at"),
                  ),
                set: { revoked_at: at, revoke_reason: input.reason ?? "revoked" },
              }),
            );
            yield* audit({
              grantId: input.grantId,
              credentialId: CredentialId.make(row.credential_id),
              actorSubject: input.actorSubject,
              effectiveSubject: Subject.make(row.effective_subject),
              action: "grant.revoke",
              outcome: "revoked",
            });
          }),
        );
      }),
      {
        actorSubject: input.actorSubject,
        effectiveSubject: input.actorSubject,
        action: "grant.revoke",
        outcome: "denied",
      },
    );

  const revokeAll = (input: {
    readonly effectiveSubject: Subject;
    readonly actorSubject: Subject;
  }) =>
    withDenialAudit(
      Effect.gen(function* () {
        if (!(yield* options.isVerifiedHuman(input.actorSubject))) {
          return yield* Effect.fail(denied("unauthorized", "Revoker is not a verified human."));
        }
        if (!(yield* options.isManagementAuthorized(input.actorSubject, input.effectiveSubject))) {
          return yield* Effect.fail(denied("unauthorized", "Revoker is not authorized."));
        }
        return yield* db.transaction(
          Effect.gen(function* () {
            const rows = yield* db.use("delegation.grant.listForSubject", (query) =>
              query.findMany("credential_delegation", {
                where: (builder) =>
                  builder.and(
                    tenantWhere(builder, "effective_subject", String(input.effectiveSubject)),
                    builder.isNull("revoked_at"),
                  ),
              }),
            );
            const at = now();
            yield* db.use("delegation.grant.revokeAll", (query) =>
              query.updateMany("credential_delegation", {
                where: (builder) =>
                  builder.and(
                    tenantWhere(builder, "effective_subject", String(input.effectiveSubject)),
                    builder.isNull("revoked_at"),
                  ),
                set: { revoked_at: at, revoke_reason: "subject-revoked" },
              }),
            );
            yield* Effect.forEach(rows, (raw) => {
              const row = parseGrant(raw);
              if (!row) return Effect.fail(invalidStoredRow("credential_delegation"));
              return audit({
                grantId: DelegationId.make(row.id),
                credentialId: CredentialId.make(row.credential_id),
                actorSubject: input.actorSubject,
                effectiveSubject: input.effectiveSubject,
                action: "grant.revoke_all",
                outcome: "revoked",
              });
            });
            return rows.length;
          }),
        );
      }),
      {
        actorSubject: input.actorSubject,
        effectiveSubject: input.effectiveSubject,
        action: "grant.revoke_all",
        outcome: "denied",
      },
    );

  const issueProofChallenge = (input: {
    readonly adapter: string;
    readonly createdBy: Subject;
    readonly effectiveSubject: Subject;
    readonly label: string;
    readonly scope: DelegationScope;
    readonly grantExpiresAt?: number;
  }) =>
    withDenialAudit(
      Effect.gen(function* () {
        if (!options.issuanceEnabled) {
          return yield* Effect.fail(
            denied("management", "Delegated credential issuance is disabled."),
          );
        }
        if (!nonEmpty(input.adapter) || !nonEmpty(input.label)) {
          return yield* Effect.fail(denied("invalid", "Challenge adapter and label are required."));
        }
        if (!(yield* options.isVerifiedHuman(input.createdBy))) {
          return yield* Effect.fail(
            denied("unauthorized", "Challenge creator is not a verified human."),
          );
        }
        if (!(yield* options.isVerifiedHuman(input.effectiveSubject))) {
          return yield* Effect.fail(
            denied("unauthorized", "Challenge target is not a verified human."),
          );
        }
        if (!(yield* options.isManagementAuthorized(input.createdBy, input.effectiveSubject))) {
          return yield* Effect.fail(denied("unauthorized", "Challenge creator is not authorized."));
        }
        const scope = normalizeScope(input.scope);
        if (!scope)
          return yield* Effect.fail(denied("invalid", "Proof scope must contain exact addresses."));
        const issuedAt = now();
        const maxTtlMs = options.maxTtlMs ?? MAX_DELEGATION_TTL_MS;
        const grantExpiresAt =
          input.grantExpiresAt ?? issuedAt + Math.min(DEFAULT_DELEGATION_TTL_MS, maxTtlMs);
        if (!validTtlWindow(issuedAt, grantExpiresAt, maxTtlMs)) {
          return yield* Effect.fail(
            denied("invalid", "Delegation expiry must be in the allowed window."),
          );
        }
        const challengeId = `challenge_${randomHex(16)}`;
        const nonce = randomHex(32);
        const challengeExpiresAt = issuedAt + PROOF_CHALLENGE_TTL_MS;
        if (!validTtlWindow(issuedAt, challengeExpiresAt, PROOF_CHALLENGE_TTL_MS)) {
          return yield* Effect.fail(denied("invalid", "Proof challenge expiry is invalid."));
        }
        const proofHash = yield* sha256Hex(nonce);
        yield* db.transaction(
          Effect.gen(function* () {
            yield* db.use("delegation.challenge.create", (query) =>
              query.create("delegation_challenge", {
                tenant,
                id: challengeId,
                created_by: String(input.createdBy),
                label: input.label,
                credential_id: null,
                credential_kind: null,
                adapter: input.adapter,
                issuer: null,
                audience: null,
                credential_subject: null,
                credential_ref: null,
                actor_subject: null,
                effective_subject: String(input.effectiveSubject),
                scope: encodeScope(scope),
                proof_hash: proofHash,
                expires_at: challengeExpiresAt,
                grant_expires_at: grantExpiresAt,
                proof_consumed_at: null,
                consent_consumed_at: null,
                created_at: nowDate(issuedAt),
              }),
            );
            yield* audit({
              actorSubject: input.createdBy,
              effectiveSubject: input.effectiveSubject,
              action: "proof.challenge",
              outcome: "challenge",
            });
          }),
        );
        return {
          challengeId,
          nonce,
          adapter: input.adapter,
          createdBy: input.createdBy,
          effectiveSubject: input.effectiveSubject,
          label: input.label,
          scope,
          grantExpiresAt,
          expiresAt: challengeExpiresAt,
        };
      }),
      {
        actorSubject: input.createdBy,
        effectiveSubject: input.effectiveSubject,
        action: "proof.challenge",
        outcome: "denied",
      },
    );

  const completeProofChallenge = (input: {
    readonly challengeId: string;
    readonly credential: VerifiedDelegatedCredential;
    readonly machineActor: Subject;
    readonly nonce: string;
  }) =>
    withDenialAudit(
      Effect.gen(function* () {
        if (!validCredential(input.credential) || !nonEmpty(String(input.machineActor))) {
          return yield* Effect.fail(denied("invalid", "Verified machine credential is invalid."));
        }
        return yield* db.transaction(
          Effect.gen(function* () {
            const rawRow = yield* db.use("delegation.challenge.get", (query) =>
              query.findFirst("delegation_challenge", {
                where: (builder) => tenantWhere(builder, "id", input.challengeId),
              }),
            );
            const row = rawRow ? parseChallenge(rawRow) : null;
            if (!row || row.proof_consumed_at !== null || row.expires_at <= now()) {
              return yield* Effect.fail(
                denied("proof", "Proof challenge is expired or already used."),
              );
            }
            if (row.adapter !== input.credential.adapter) {
              return yield* Effect.fail(
                denied("proof", "Credential adapter does not match the challenge."),
              );
            }
            const proofHash = yield* sha256Hex(input.nonce);
            if (!constantTimeHexEqual(proofHash, row.proof_hash)) {
              return yield* Effect.fail(denied("proof", "Challenge nonce is invalid."));
            }
            if (
              !(yield* options.verifyProof({
                challengeId: row.id,
                credential: input.credential,
                machineActor: input.machineActor,
                nonce: input.nonce,
              }))
            ) {
              return yield* Effect.fail(denied("proof", "Proof of possession failed."));
            }
            const completedScope = rowScope(row);
            if (!completedScope)
              return yield* Effect.fail(denied("proof", "Proof challenge scope is invalid."));
            yield* claimChallengePhase({
              challengeId: input.challengeId,
              phase: "proof",
              actorSubject: input.machineActor,
              effectiveSubject: Subject.make(row.effective_subject),
            }).pipe(
              Effect.catchTag("UniqueViolationError", () =>
                Effect.fail(denied("proof", "Proof challenge has already been used.")),
              ),
            );
            yield* db.use("delegation.challenge.consumeProof", (query) =>
              query.updateMany("delegation_challenge", {
                where: (builder) =>
                  builder.and(
                    builder("tenant", "=", tenant),
                    builder("id", "=", input.challengeId),
                    builder.isNull("proof_consumed_at"),
                  ),
                set: {
                  credential_kind: input.credential.kind,
                  issuer: input.credential.issuer,
                  audience: input.credential.audience,
                  credential_subject: input.credential.subject,
                  credential_ref: input.credential.credentialRef,
                  actor_subject: String(input.machineActor),
                  proof_consumed_at: now(),
                },
              }),
            );
            const consumedRaw = yield* db.use("delegation.challenge.consumeProof.verify", (query) =>
              query.findFirst("delegation_challenge", {
                where: (builder) => tenantWhere(builder, "id", input.challengeId),
              }),
            );
            const consumed = consumedRaw ? parseChallenge(consumedRaw) : null;
            if (
              !consumed ||
              consumed.proof_consumed_at === null ||
              consumed.credential_kind !== input.credential.kind ||
              consumed.issuer !== input.credential.issuer ||
              consumed.audience !== input.credential.audience ||
              consumed.credential_subject !== input.credential.subject ||
              consumed.credential_ref !== input.credential.credentialRef ||
              consumed.actor_subject !== String(input.machineActor)
            ) {
              return yield* Effect.fail(denied("proof", "Proof challenge was already used."));
            }
            yield* audit({
              actorSubject: input.machineActor,
              effectiveSubject: Subject.make(row.effective_subject),
              action: "proof.complete",
              outcome: "allowed",
            });
            return {
              challengeId: row.id,
              credential: input.credential,
              actorSubject: input.machineActor,
              effectiveSubject: Subject.make(row.effective_subject),
              scope: completedScope,
            } satisfies ProofCompletion;
          }),
        );
      }),
      {
        actorSubject: input.machineActor,
        effectiveSubject: input.machineActor,
        action: "proof.complete",
        outcome: "denied",
      },
    );

  api = {
    create,
    resolve,
    resolveIssuedKey,
    resolveBinding,
    revalidate,
    get,
    list,
    getChallenge,
    createIssuedKey,
    rotateIssuedKey,
    registerProviderIssuedKey,
    rotateProviderIssuedKey,
    expand,
    revoke,
    revokeAll,
    audit,
    listAudit,
    listNotifications,
    markNotificationRead,
    issueProofChallenge,
    completeProofChallenge,
  };
  return api;
};

/** One gate used by catalog, schema, dispatch, approval, and resume paths. */
export const assertDelegationCapability = (
  context: DelegationContext | undefined,
  capability: DelegationCapability,
): Effect.Effect<void, DelegationDeniedError | StorageFailure> =>
  context === undefined
    ? Effect.void
    : Effect.gen(function* () {
        yield* context.revalidate(capability);
        if (capability.operation === "management") {
          return yield* Effect.fail(
            denied("management", "Delegated credentials cannot manage this surface."),
          );
        }
      });

export const isDelegatedContext = (value: unknown): value is DelegationContext =>
  asRecord(value)?.["kind"] === "delegated";

export const generateDelegatedKey = (): Effect.Effect<
  { readonly secret: string; readonly hash: string },
  never
> =>
  Effect.gen(function* () {
    const secret = randomHex(32);
    return { secret, hash: yield* sha256Hex(secret) };
  });
