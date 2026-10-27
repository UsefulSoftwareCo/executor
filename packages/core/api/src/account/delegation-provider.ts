import { Effect, Layer, Match, Predicate, Schema } from "effect";

import {
  DelegationProvider,
  type DelegationProviderShape,
  type DelegationRequestContext,
} from "./service";
import {
  AccountBadRequest,
  AccountConflict,
  AccountError,
  AccountForbidden,
  AccountUnauthorized,
} from "./api";
import {
  CredentialId,
  DelegationDeniedError,
  Subject,
  type DelegationGrantView,
  type DelegationService,
  type VerifiedDelegatedCredential,
} from "@executor-js/sdk";

/** The host supplies the live provider authority. The callbacks are invoked
 * for every account request, so a Better Auth/WorkOS membership change takes
 * effect without waiting for a cached registry or a process restart. */
export interface DelegationAccountHost {
  readonly service: (
    request: DelegationRequestContext,
    human?: DelegationHuman,
  ) => Effect.Effect<DelegationService, DelegationAccountFailure>;
  readonly human: (
    request: DelegationRequestContext,
  ) => Effect.Effect<DelegationHuman, DelegationAccountFailure>;
  readonly targets: (
    request: DelegationRequestContext,
  ) => Effect.Effect<readonly ApiTarget[], DelegationAccountFailure>;
  readonly target: (
    request: DelegationRequestContext,
    subject: string,
  ) => Effect.Effect<ApiTarget | null, DelegationAccountFailure>;
  /** Return human-readable, exact-snapshot choices for a verified target.
   * Hosts must derive these from the same live catalog used by `scope`; IDs
   * remain the only values accepted when a grant is created. */
  readonly scopeOptions?: (
    request: DelegationRequestContext,
    targetSubject: string,
  ) => Effect.Effect<DelegationScopeOptions, DelegationAccountFailure>;
  /** Convert the UI's toolkit ids into the exact frozen tool/connection
   * snapshot stored by core. A host must use its live executor catalog here;
   * accepting ids as wildcard prefixes would make later edits widen a grant. */
  readonly scope: (
    request: DelegationRequestContext,
    targetSubject: string,
    scope: ApiDelegationScope,
  ) => Effect.Effect<import("@executor-js/sdk").DelegationScope, DelegationAccountFailure>;
  /** Disable a target's verified-human status after all of its grants have
   * been revoked. Hosts use this for durable offboarding tombstones; the
   * callback runs only after the grant revocation has committed, so a failure
   * cannot leave active credentials behind. */
  readonly onRevokeAll?: (
    request: DelegationRequestContext,
    targetSubject: string,
    disableTarget: boolean,
  ) => Effect.Effect<void, DelegationAccountFailure>;
  /** Verify possession on the authenticated machine request. The callback
   * must return a stable tuple and never a raw bearer value. */
  readonly proof: (
    request: DelegationRequestContext,
    adapter: string,
  ) => Effect.Effect<DelegationProof, DelegationAccountFailure>;
  /** Host/provider key authority for local credentials. The secret is returned
   * exactly once; core persists only the verified provider tuple through its
   * provider-issued binding operation. This seam is intentionally separate
   * from the SDK-local fallback so a host can reuse its existing bearer-key
   * verifier and compensate an unbound provider key. */
  readonly providerKeys?: DelegationAccountKeyStore;
  readonly externalAdapters: readonly string[];
  readonly localKeysEnabled: boolean;
  readonly issuanceEnabled: boolean;
}

export interface DelegationProviderKey {
  readonly credential: VerifiedDelegatedCredential;
  readonly actorSubject: string;
  readonly secret: string;
}

export interface DelegationAccountKeyStore {
  readonly issue: (
    request: DelegationRequestContext,
    input: {
      readonly targetSubject: string;
      readonly label: string;
      readonly expiresAt: string;
    },
  ) => Effect.Effect<DelegationProviderKey, DelegationAccountFailure>;
  /** Persist the SDK credential id to provider key id mapping. This is what
   * lets a later rotate/revoke request address the provider key without
   * exposing the full credential tuple through the HTTP projection. */
  readonly bind: (
    request: DelegationRequestContext,
    input: {
      readonly credentialId: string;
      readonly targetSubject: string;
      readonly credential: VerifiedDelegatedCredential;
    },
  ) => Effect.Effect<void, DelegationAccountFailure>;
  readonly rotate: (
    request: DelegationRequestContext,
    input: {
      readonly credentialId: string;
      readonly targetSubject: string;
      readonly label: string;
      readonly expiresAt: string;
    },
  ) => Effect.Effect<DelegationProviderKey, DelegationAccountFailure>;
  /** Revoke a bound provider key by the stable SDK credential id. The host
   * maintains the provider-id mapping established by `issue`/`rotate`. */
  readonly revokeBound: (
    request: DelegationRequestContext,
    input: {
      readonly credentialId: string;
      /** Exact provider reference retained by the server-side grant view. */
      readonly credentialRef: string;
      readonly targetSubject?: string;
    },
  ) => Effect.Effect<void, DelegationAccountFailure>;
  readonly revoke: (
    request: DelegationRequestContext,
    input: { readonly credential: VerifiedDelegatedCredential },
  ) => Effect.Effect<void, DelegationAccountFailure>;
}

export interface DelegationHuman {
  readonly subject: string;
  readonly organizationId: string;
  readonly recent: boolean;
  /** Cross-target reads are reserved for organization administrators. */
  readonly canFilterTargets?: boolean;
}

export interface DelegationProof {
  readonly credential: VerifiedDelegatedCredential;
  readonly machineActor: string;
}

type DelegationAccountFailure =
  | AccountError
  | AccountUnauthorized
  | AccountForbidden
  | AccountBadRequest
  | AccountConflict;

type ApiDelegationScope = typeof import("./api").DelegationScope.Type;
type ApiTargetSelector = typeof import("./api").DelegationTargetSelector.Type;
type ApiCredentialSummary = typeof import("./api").DelegatedCredentialSummary.Type;
type ApiChallenge = typeof import("./api").DelegationChallengeResponse.Type;
type ApiTarget = typeof import("./api").DelegationTarget.Type;
type DelegationScopeOptions = typeof import("./api").DelegationScopeOptionsResponse.Type;
type ApiDelivery = typeof import("./api").DelegationDelivery.Type;
type ApiNotification = typeof import("./api").DelegationNotification.Type;

type DelegationDeniedShape = { readonly reason: DelegationDeniedError["reason"] };

const isDelegationDenied = (error: unknown): error is DelegationDeniedShape =>
  Predicate.isTagged(error, "DelegationDeniedError") &&
  Predicate.hasProperty("reason")(error) &&
  typeof error.reason === "string";

const isAccountError = Schema.is(AccountError);
const isAccountUnauthorized = Schema.is(AccountUnauthorized);
const isAccountForbidden = Schema.is(AccountForbidden);
const isAccountBadRequest = Schema.is(AccountBadRequest);
const isAccountConflict = Schema.is(AccountConflict);

const deniedError = (error: DelegationDeniedShape): DelegationAccountFailure => {
  const message = `Delegation request denied (${error.reason}).`;
  return Match.value(error.reason).pipe(
    Match.when("unmapped", () => new AccountUnauthorized()),
    Match.when("invalid", () => new AccountBadRequest({ message })),
    Match.when("proof", () => new AccountBadRequest({ message })),
    Match.when("scope", () => new AccountBadRequest({ message })),
    Match.when("unauthorized", () => new AccountForbidden({ message })),
    Match.when("management", () => new AccountForbidden({ message })),
    Match.when("expired", () => new AccountForbidden({ message })),
    Match.when("revoked", () => new AccountForbidden({ message })),
    Match.exhaustive,
  );
};

const mapFailure = (error: unknown): DelegationAccountFailure => {
  if (isDelegationDenied(error)) return deniedError(error);
  if (isAccountError(error)) return error;
  if (isAccountUnauthorized(error)) return error;
  if (isAccountForbidden(error)) return error;
  if (isAccountBadRequest(error)) return error;
  if (isAccountConflict(error)) return error;
  return new AccountError({ message: "Delegation request failed." });
};

const run = <A, E>(
  effect: Effect.Effect<A, E, never>,
): Effect.Effect<A, DelegationAccountFailure> => effect.pipe(Effect.mapError(mapFailure));

const iso = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const maskedReference = (value: string): string =>
  value.length <= 8 ? "••••" : `${value.slice(0, 4)}…${value.slice(-4)}`;

const selectorFor = (human: DelegationHuman, subject: string): ApiTargetSelector =>
  subject === human.subject ? { kind: "self" } : { kind: "verified-human", id: subject };

const actorFor = (
  subject: string,
  lookup: (subject: string) => ApiTarget | null,
): typeof import("./api").DelegationActor.Type => {
  const target = lookup(subject);
  if (target)
    return {
      kind: "human",
      id: target.id,
      email: target.email,
      name: target.name,
    };
  return { kind: "machine", adapter: "delegated", reference: maskedReference(subject) };
};

const referenceFor = (
  view: DelegationGrantView,
): typeof import("./api").DelegationCredentialReference.Type =>
  view.credentialKind === "issued-key"
    ? { kind: "local-key", prefix: view.credentialRefMasked }
    : { kind: "external", adapter: view.adapter, reference: view.credentialRefMasked };

const scopeFor = (scope: import("@executor-js/sdk").DelegationScope): ApiDelegationScope => ({
  scopes: scope.actions,
  toolkitIds: scope.toolkitMembership.map((entry) => entry.toolkitId),
  ...(scope.connectionAddresses === undefined
    ? {}
    : { connectionIds: scope.connectionAddresses.map(String) }),
});

const targetSelectorFor = (human: DelegationHuman, subject: string): ApiTargetSelector =>
  selectorFor(human, subject);

const lifecycleFor = (
  view: DelegationGrantView,
): typeof import("@executor-js/api").DelegationLifecycle.Type => {
  const revoked = view.revokedAt !== null;
  return {
    status: revoked ? "revoked" : view.expiresAt <= Date.now() ? "expired" : "active",
    expiresAt: new Date(view.expiresAt).toISOString(),
    revokedAt: iso(view.revokedAt),
    revokeReason: revoked ? "revoked" : null,
  };
};

const deliveryUnavailable: ApiDelivery = {
  status: "unavailable",
  channel: null,
  occurredAt: null,
};

const summaryFor = (
  human: DelegationHuman,
  view: DelegationGrantView,
  target: ApiTarget,
  lookup: (subject: string) => ApiTarget | null,
): ApiCredentialSummary => ({
  id: String(view.credentialId),
  grantId: String(view.grantId),
  label: view.label,
  credentialKind: view.credentialKind === "issued-key" ? "local-key" : "external",
  reference: referenceFor(view),
  target,
  scope: scopeFor(view.scope),
  lifecycle: lifecycleFor(view),
  createdAt: new Date(view.createdAt).toISOString(),
  createdBy: actorFor(String(view.createdBy), lookup),
  lastUsedAt: iso(view.lastUsedAt),
  supportsRotation: view.credentialKind === "issued-key",
  notification: view.credentialKind === "external" ? deliveryUnavailable : null,
});

const notificationFor = (
  notification: import("@executor-js/sdk").DelegationNotificationRecord,
  target: ApiTarget,
): ApiNotification => ({
  id: notification.id,
  target,
  title: "Delegated credential created",
  message: `${notification.label} was created for your account by ${String(notification.createdBy)}.`,
  createdAt: new Date(notification.createdAt).toISOString(),
  readAt: iso(notification.readAt),
});

const challengeStatus = (
  challenge: import("@executor-js/sdk").DelegationChallengeView,
): ApiChallenge["status"] =>
  challenge.consentConsumedAt !== null
    ? "consented"
    : challenge.proofConsumedAt !== null
      ? "proof-complete"
      : challenge.expiresAt <= Date.now()
        ? "expired"
        : "awaiting-proof";

const challengeFor = (
  challenge: import("@executor-js/sdk").DelegationChallengeView,
  target: ApiTargetSelector,
  credential: ApiCredentialSummary | null,
  nonce = "nonce" in challenge && typeof challenge.nonce === "string" ? challenge.nonce : "",
): ApiChallenge => ({
  id: challenge.challengeId,
  // The nonce is returned by the core challenge creation operation. It is not
  // persisted in the projection and is intentionally unavailable on a later
  // GET; callers retain the create response for machine completion.
  nonce,
  status: challengeStatus(challenge),
  expiresAt: new Date(challenge.expiresAt).toISOString(),
  adapter: challenge.adapter,
  target,
  scope: scopeFor(challenge.scope),
  label: challenge.label,
  instructions: null,
  provenCredential:
    challenge.provenCredentialKind === null || challenge.provenCredentialRefMasked === null
      ? null
      : challenge.provenCredentialKind === "issued-key"
        ? { kind: "local-key", prefix: challenge.provenCredentialRefMasked }
        : {
            kind: "external",
            adapter: challenge.adapter,
            reference: challenge.provenCredentialRefMasked,
          },
  credential,
});

const sameStrings = (left: readonly unknown[], right: readonly unknown[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => String(value) === String(right[index]));

const sameScope = (
  left: import("@executor-js/sdk").DelegationScope,
  right: import("@executor-js/sdk").DelegationScope,
): boolean =>
  sameStrings(left.actions, right.actions) &&
  sameStrings(left.toolAddresses, right.toolAddresses) &&
  (left.connectionAddresses === undefined
    ? right.connectionAddresses === undefined
    : right.connectionAddresses !== undefined &&
      sameStrings(left.connectionAddresses, right.connectionAddresses)) &&
  left.toolkitMembership.length === right.toolkitMembership.length &&
  left.toolkitMembership.every((toolkit, index) => {
    const other = right.toolkitMembership[index];
    return (
      other !== undefined &&
      toolkit.toolkitId === other.toolkitId &&
      toolkit.revision === other.revision &&
      sameStrings(toolkit.toolAddresses, other.toolAddresses) &&
      sameStrings(toolkit.connectionAddresses, other.connectionAddresses)
    );
  });

/** Build the account-plane provider used by all hosts. Every host-specific
 * decision (session freshness, same-origin, membership, provider proof, and
 * exact toolkit snapshot) stays in `DelegationAccountHost`; this module only
 * translates the neutral HTTP contract to the carrier-neutral SDK service. */
export const makeDelegationProvider = (
  host: DelegationAccountHost,
): Layer.Layer<DelegationProvider> =>
  Layer.succeed(DelegationProvider, {
    listDelegatedCredentials: (request, query) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        const targetSubject =
          query.targetId === undefined
            ? human.subject
            : yield* targetSubjectForHistorical(host, request, human, {
                kind: "verified-human",
                id: query.targetId,
              });
        const service = yield* host.service(request, human);
        const views = yield* run(
          service.list({
            effectiveSubject: Subject.make(targetSubject),
            includeRevoked: query.includeRevoked === "true",
          }),
        );
        const targets = yield* host.targets(request);
        const visibleTargets =
          human.canFilterTargets === true
            ? targets
            : targets.filter((target) => target.id === human.subject);
        const bySubject = new Map(visibleTargets.map((target) => [target.id, target]));
        const actorBySubject = new Map(targets.map((target) => [target.id, target]));
        const credentials = views.map((view) => {
          const subject = String(view.effectiveSubject);
          const target = bySubject.get(subject) ?? historicalTargetFor(human, subject);
          return summaryFor(
            human,
            view,
            target,
            (actorSubject) => actorBySubject.get(actorSubject) ?? null,
          );
        });
        const notificationRecords = yield* run(
          service.listNotifications({ reader: Subject.make(human.subject) }),
        );
        const notifications = notificationRecords.map((notification) =>
          notificationFor(
            notification,
            bySubject.get(String(notification.targetSubject)) ??
              historicalTargetFor(human, String(notification.targetSubject)),
          ),
        );
        return {
          credentials,
          nextCursor: null,
          capabilities: {
            issuanceEnabled: host.issuanceEnabled,
            localKeysEnabled: host.localKeysEnabled && host.providerKeys !== undefined,
            externalAdapters: [...host.externalAdapters],
            canFilterTargets: human.canFilterTargets === true,
          },
          notifications,
        };
      }).pipe(Effect.mapError(mapFailure)),

    listDelegationTargets: (request) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        const targets = yield* host.targets(request);
        return {
          targets:
            human.canFilterTargets === true
              ? targets
              : targets.filter((target) => target.id === human.subject),
        };
      }),

    listDelegationScopeOptions: (request, query) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        const targetSubject =
          query.targetId === undefined
            ? human.subject
            : yield* targetSubjectForHistorical(host, request, human, {
                kind: "verified-human",
                id: query.targetId,
              });
        if (!host.scopeOptions)
          return yield* new AccountForbidden({
            message: "This host does not expose delegation scope choices.",
          });
        return yield* run(host.scopeOptions(request, targetSubject));
      }),

    listDelegationNotifications: (request) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        const service = yield* host.service(request, human);
        const records = yield* run(
          service.listNotifications({ reader: Subject.make(human.subject) }),
        );
        const targets = yield* host.targets(request);
        const bySubject = new Map(targets.map((target) => [target.id, target]));
        const notifications = records.map((notification) =>
          notificationFor(
            notification,
            bySubject.get(String(notification.targetSubject)) ??
              historicalTargetFor(human, String(notification.targetSubject)),
          ),
        );
        return { notifications };
      }),
    markDelegationNotificationRead: (request, notificationId) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        const service = yield* host.service(request, human);
        yield* run(
          service.markNotificationRead({
            notificationId,
            reader: Subject.make(human.subject),
          }),
        );
        return { success: true };
      }),

    createDelegatedKey: (request, body) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        if (!human.recent)
          return yield* new AccountForbidden({
            message: "Recent human authentication is required.",
          });
        const targetSubject = yield* targetSubjectFor(host, request, human, body.target);
        const coreScope = yield* host.scope(request, targetSubject, body.scope);
        const service = yield* host.service(request, human);
        const keyStore = host.providerKeys;
        if (!keyStore)
          return yield* new AccountForbidden({
            message: "This host does not provide delegated local keys.",
          });
        const issued = yield* keyStore.issue(request, {
          targetSubject,
          label: body.label,
          expiresAt: body.expiresAt,
        });
        const grant = yield* run(
          service.registerProviderIssuedKey({
            createdBy: Subject.make(human.subject),
            effectiveSubject: Subject.make(targetSubject),
            actorSubject: Subject.make(issued.actorSubject),
            label: body.label,
            scope: coreScope,
            credential: issued.credential,
            expiresAt: Date.parse(body.expiresAt),
          }),
        ).pipe(
          Effect.catch((error: DelegationAccountFailure) =>
            keyStore.revoke(request, { credential: issued.credential }).pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
        yield* keyStore
          .bind(request, {
            credentialId: String(grant.credentialId),
            targetSubject,
            credential: issued.credential,
          })
          .pipe(
            Effect.catch((error: DelegationAccountFailure) =>
              Effect.gen(function* () {
                yield* run(
                  service.revoke({
                    grantId: grant.grantId,
                    actorSubject: Subject.make(human.subject),
                    reason: "provider-binding-failed",
                  }),
                ).pipe(Effect.ignore);
                yield* keyStore
                  .revoke(request, { credential: issued.credential })
                  .pipe(Effect.ignore);
                return yield* error;
              }),
            ),
          );
        const target = yield* host.target(request, targetSubject);
        if (!target)
          return yield* new AccountBadRequest({ message: "Delegation target is unavailable." });
        const view = yield* run(service.get(grant.grantId));
        if (!view) return yield* new AccountError({ message: "Delegated key was not persisted." });
        const actors = yield* host.targets(request);
        const actorBySubject = new Map(actors.map((actor) => [actor.id, actor]));
        return {
          credential: summaryFor(
            human,
            view,
            target,
            (subject) => actorBySubject.get(subject) ?? null,
          ),
          value: issued.secret,
        };
      }).pipe(Effect.mapError(mapFailure)),

    startDelegationChallenge: (request, body) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        if (!human.recent)
          return yield* new AccountForbidden({
            message: "Recent human authentication is required.",
          });
        const targetSubject = yield* targetSubjectFor(host, request, human, body.target);
        const coreScope = yield* host.scope(request, targetSubject, body.scope);
        const service = yield* host.service(request, human);
        const challenge = yield* run(
          service.issueProofChallenge({
            adapter: body.adapter,
            createdBy: Subject.make(human.subject),
            effectiveSubject: Subject.make(targetSubject),
            label: body.label,
            scope: coreScope,
            grantExpiresAt: Date.parse(body.expiresAt),
          }),
        );
        const target = yield* host.target(request, targetSubject);
        if (!target)
          return yield* new AccountBadRequest({ message: "Delegation target is unavailable." });
        const view = yield* run(service.getChallenge(challenge.challengeId));
        if (!view)
          return yield* new AccountError({ message: "Delegation challenge was not persisted." });
        return challengeFor(view, targetSelectorFor(human, targetSubject), null, challenge.nonce);
      }).pipe(Effect.mapError(mapFailure)),

    getDelegationChallenge: (request, challengeId) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        const service = yield* host.service(request, human);
        const challenge = yield* run(service.getChallenge(challengeId));
        if (!challenge)
          return yield* new AccountBadRequest({ message: "Delegation challenge not found." });
        const target = yield* host.target(request, String(challenge.effectiveSubject));
        if (!target)
          return yield* new AccountForbidden({ message: "Delegation target is unavailable." });
        return challengeFor(
          challenge,
          targetSelectorFor(human, String(challenge.effectiveSubject)),
          null,
        );
      }).pipe(Effect.mapError(mapFailure)),

    completeDelegationProof: (request, challengeId, body) =>
      Effect.gen(function* () {
        const service = yield* host.service(request);
        const challenge = yield* run(service.getChallenge(challengeId));
        if (!challenge)
          return yield* new AccountBadRequest({ message: "Delegation challenge not found." });
        const proof = yield* host.proof(request, challenge.adapter);
        const completion = yield* run(
          service.completeProofChallenge({
            challengeId,
            credential: proof.credential,
            machineActor: Subject.make(proof.machineActor),
            nonce: body.nonce,
          }),
        );
        const updated = yield* run(service.getChallenge(challengeId));
        if (!updated)
          return yield* new AccountError({ message: "Delegation challenge disappeared." });
        const target = yield* host.target(request, String(completion.effectiveSubject));
        if (!target)
          return yield* new AccountForbidden({ message: "Delegation target is unavailable." });
        return challengeFor(
          updated,
          { kind: "verified-human", id: String(completion.effectiveSubject) },
          null,
        );
      }).pipe(Effect.mapError(mapFailure)),

    consentDelegationChallenge: (request, challengeId, body) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        if (!human.recent)
          return yield* new AccountForbidden({
            message: "Recent human authentication is required.",
          });
        const service = yield* host.service(request, human);
        const challenge = yield* run(service.getChallenge(challengeId));
        if (!challenge)
          return yield* new AccountBadRequest({ message: "Delegation challenge not found." });
        const targetSubject = String(challenge.effectiveSubject);
        const requested = yield* host.scope(request, targetSubject, body.scope);
        if (
          !sameScope(requested, challenge.scope) ||
          Date.parse(body.expiresAt) !== challenge.grantExpiresAt
        ) {
          return yield* new AccountConflict({
            message: "Consent cannot change the challenged scope or expiry.",
          });
        }
        const grant = yield* run(
          service.create({
            proofChallengeId: challengeId,
            consentedBy: Subject.make(human.subject),
          }),
        );
        const view = yield* run(service.get(grant.grantId));
        const target = yield* host.target(request, targetSubject);
        if (!view || !target)
          return yield* new AccountError({ message: "Delegated credential was not persisted." });
        const actors = yield* host.targets(request);
        const actorBySubject = new Map(actors.map((actor) => [actor.id, actor]));
        const updated = yield* run(service.getChallenge(challengeId));
        if (!updated)
          return yield* new AccountError({ message: "Delegation challenge disappeared." });
        return challengeFor(
          updated,
          targetSelectorFor(human, targetSubject),
          summaryFor(human, view, target, (subject) => actorBySubject.get(subject) ?? null),
        );
      }).pipe(Effect.mapError(mapFailure)),

    consentDelegatedCredential: () =>
      Effect.fail(
        new AccountBadRequest({ message: "External credentials require a proof challenge." }),
      ),

    rotateDelegatedKey: (request, credentialId) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        if (!human.recent)
          return yield* new AccountForbidden({
            message: "Recent human authentication is required.",
          });
        const keyStore = host.providerKeys;
        if (!keyStore)
          return yield* new AccountForbidden({
            message: "This host does not provide delegated local keys.",
          });
        const service = yield* host.service(request, human);
        const previous = yield* run(
          service.list({ credentialId: CredentialId.make(credentialId), includeRevoked: true }),
        );
        const previousView = previous[0];
        if (!previousView)
          return yield* new AccountBadRequest({ message: "Delegated credential not found." });
        if (previousView.credentialKind !== "issued-key")
          return yield* new AccountBadRequest({ message: "Only local keys can rotate." });
        const issued = yield* keyStore.rotate(request, {
          credentialId,
          targetSubject: String(previousView.effectiveSubject),
          label: previousView.label,
          expiresAt: new Date(previousView.expiresAt).toISOString(),
        });
        const grant = yield* run(
          service.rotateProviderIssuedKey({
            credentialId: CredentialId.make(credentialId),
            managedBy: Subject.make(human.subject),
            actorSubject: Subject.make(issued.actorSubject),
            credential: issued.credential,
            expiresAt: previousView.expiresAt,
          }),
        ).pipe(
          Effect.catch((error: DelegationAccountFailure) =>
            keyStore.revoke(request, { credential: issued.credential }).pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
        yield* keyStore
          .bind(request, {
            credentialId: String(grant.credentialId),
            targetSubject: String(grant.effectiveSubject),
            credential: issued.credential,
          })
          .pipe(
            Effect.catch((error: DelegationAccountFailure) =>
              Effect.gen(function* () {
                yield* run(
                  service.revoke({
                    grantId: grant.grantId,
                    actorSubject: Subject.make(human.subject),
                    reason: "provider-binding-failed",
                  }),
                ).pipe(Effect.ignore);
                yield* keyStore
                  .revoke(request, { credential: issued.credential })
                  .pipe(Effect.ignore);
                return yield* error;
              }),
            ),
          );
        const view = yield* run(service.get(grant.grantId));
        const target = yield* host.target(request, String(grant.effectiveSubject));
        if (!view || !target)
          return yield* new AccountError({ message: "Rotated credential was not persisted." });
        const actors = yield* host.targets(request);
        const actorBySubject = new Map(actors.map((actor) => [actor.id, actor]));
        return {
          credential: summaryFor(
            human,
            view,
            target,
            (subject) => actorBySubject.get(subject) ?? null,
          ),
          value: issued.secret,
        };
      }).pipe(Effect.mapError(mapFailure)),

    revokeDelegatedCredential: (request, credentialId) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        const service = yield* host.service(request, human);
        const view = yield* run(
          service.list({ credentialId: CredentialId.make(credentialId), includeRevoked: true }),
        );
        const grant = view[0];
        if (!grant)
          return yield* new AccountBadRequest({ message: "Delegated credential not found." });
        if (grant.credentialKind === "issued-key") {
          const keyStore = host.providerKeys;
          if (!keyStore)
            return yield* new AccountForbidden({
              message: "This host does not provide delegated local keys.",
            });
          // The local grant tombstone is authoritative. Revoke it before
          // contacting the upstream provider so an outage cannot leave a
          // still-usable grant behind; provider cleanup is retryable and
          // idempotent after the local deny is durable.
          yield* run(
            service.revoke({ grantId: grant.grantId, actorSubject: Subject.make(human.subject) }),
          );
          yield* keyStore.revokeBound(request, {
            credentialId,
            credentialRef: grant.credentialRef,
            targetSubject: String(grant.effectiveSubject),
          });
          return { success: true };
        }
        yield* run(
          service.revoke({ grantId: grant.grantId, actorSubject: Subject.make(human.subject) }),
        );
        return { success: true };
      }).pipe(Effect.mapError(mapFailure)),

    revokeAllDelegatedCredentials: (request, body) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        if (body.disableTarget === true && human.canFilterTargets !== true)
          return yield* new AccountForbidden({
            message: "Only an organization administrator can block future delegations.",
          });
        if (body.disableTarget === true && host.onRevokeAll === undefined)
          return yield* new AccountForbidden({
            message: "This host cannot block future delegations.",
          });
        const targetSubject = yield* targetSubjectForHistorical(host, request, human, body.target);
        const service = yield* host.service(request, human);
        const grants = yield* run(service.list({ effectiveSubject: Subject.make(targetSubject) }));
        const providerGrants = grants.filter((grant) => grant.credentialKind === "issued-key");
        const keyStore = host.providerKeys;
        if (providerGrants.length > 0 && !keyStore)
          return yield* new AccountForbidden({
            message: "This host does not provide delegated local keys.",
          });
        const revokedCount = yield* run(
          service.revokeAll({
            effectiveSubject: Subject.make(targetSubject),
            actorSubject: Subject.make(human.subject),
          }),
        );
        if (keyStore)
          yield* Effect.forEach(providerGrants, (grant) =>
            keyStore.revokeBound(request, {
              credentialId: String(grant.credentialId),
              credentialRef: grant.credentialRef,
              targetSubject: String(grant.effectiveSubject),
            }),
          );
        if (body.disableTarget === true && host.onRevokeAll !== undefined) {
          yield* host.onRevokeAll(request, targetSubject, true);
        }
        return { revokedCount };
      }).pipe(Effect.mapError(mapFailure)),

    listDelegationAudit: (request, query) =>
      Effect.gen(function* () {
        const human = yield* host.human(request);
        const targetSubject =
          query.targetId === undefined
            ? human.subject
            : yield* targetSubjectForHistorical(host, request, human, {
                kind: "verified-human",
                id: query.targetId,
              });
        const service = yield* host.service(request, human);
        const credentialViews =
          query.credentialId === undefined
            ? []
            : yield* run(
                service.list({
                  credentialId: CredentialId.make(query.credentialId),
                  includeRevoked: true,
                }),
              );
        const matchingCredential =
          query.credentialId === undefined
            ? undefined
            : credentialViews.find((view) =>
                human.canFilterTargets === true && query.targetId === undefined
                  ? true
                  : String(view.effectiveSubject) === targetSubject,
              );
        const events =
          query.credentialId !== undefined && matchingCredential === undefined
            ? []
            : yield* run(
                matchingCredential
                  ? service.listAudit({ grantId: matchingCredential.grantId })
                  : service.listAudit({ effectiveSubject: Subject.make(targetSubject) }),
              );
        const targets = yield* host.targets(request);
        const visibleTargets =
          human.canFilterTargets === true
            ? targets
            : targets.filter((target) => target.id === human.subject);
        const bySubject = new Map(visibleTargets.map((target) => [target.id, target]));
        const actorBySubject = new Map(targets.map((target) => [target.id, target]));
        return {
          events: events.map((event) => ({
            id: event.id,
            grantId: event.grantId === null ? null : String(event.grantId),
            credentialId: event.credentialId === null ? null : String(event.credentialId),
            actor: actorFor(
              String(event.actorSubject),
              (subject) => actorBySubject.get(subject) ?? null,
            ),
            effectiveTarget: bySubject.get(String(event.effectiveSubject)) ?? {
              id: String(event.effectiveSubject),
              email: "",
              name: null,
              isCurrentUser: false,
              status: "removed",
            },
            action: event.action,
            outcome: event.outcome,
            tool: event.tool === null ? null : String(event.tool),
            requestId: event.requestId,
            executionId: event.executionId,
            occurredAt: new Date(event.occurredAt).toISOString(),
          })),
          nextCursor: null,
        };
      }).pipe(Effect.mapError(mapFailure)),
  } satisfies DelegationProviderShape);

const targetSubjectFor = (
  host: DelegationAccountHost,
  request: DelegationRequestContext,
  human: DelegationHuman,
  selector: ApiTargetSelector,
): Effect.Effect<string, DelegationAccountFailure> =>
  selector.kind === "self"
    ? Effect.succeed(human.subject)
    : human.canFilterTargets !== true && selector.id !== human.subject
      ? Effect.fail(
          new AccountForbidden({ message: "Only administrators may select another target." }),
        )
      : host
          .target(request, selector.id)
          .pipe(
            Effect.flatMap((target) =>
              target?.status === "verified"
                ? Effect.succeed(target.id)
                : Effect.fail(
                    new AccountForbidden({ message: "Delegation target is unavailable." }),
                  ),
            ),
          );

/** Resolve a target for reads and revocation. An administrator may address a
 * persisted historical subject after its live directory membership has been
 * removed or suspended. Issuance and expansion continue to use
 * `targetSubjectFor`, which requires an active verified target. */
const targetSubjectForHistorical = (
  _host: DelegationAccountHost,
  _request: DelegationRequestContext,
  human: DelegationHuman,
  selector: ApiTargetSelector,
): Effect.Effect<string, DelegationAccountFailure> =>
  selector.kind === "self"
    ? Effect.succeed(human.subject)
    : human.canFilterTargets !== true && selector.id !== human.subject
      ? Effect.fail(
          new AccountForbidden({ message: "Only administrators may select another target." }),
        )
      : Effect.succeed(selector.id);

const historicalTargetFor = (human: DelegationHuman, subject: string): ApiTarget => ({
  id: subject,
  email: "",
  name: null,
  isCurrentUser: subject === human.subject,
  status: "removed",
});
