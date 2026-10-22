import { Effect, Layer } from "effect";

import {
  IdentityProvider,
  Unauthorized,
  type ExecutorDbHandle,
  type Principal,
} from "@executor-js/api/server";
import type { VerifiedHumanSubjectRegistry } from "@executor-js/sdk";

import type { CloudflareConfig } from "../config";
import {
  classifyAccessClaims,
  delegatedCredentialFromAccessClaims,
  makeAccessVerifier,
  type AccessVerifierOptions,
} from "./cloudflare-access";
import { makeCloudflareDelegationAuthority, makeCloudflareDelegationService } from "./delegation";

const delegatedPrincipalFrom = (
  grant: import("@executor-js/sdk").DelegationGrant,
  config: CloudflareConfig,
): Principal => ({
  kind: "delegated",
  accountId: String(grant.effectiveSubject),
  organizationId: config.organizationId,
  organizationName: config.organizationName,
  organizationSlug: config.organizationSlug,
  email: "",
  name: null,
  avatarUrl: null,
  roles: [],
  orgRoleModel: "organization",
  orgRole: "member",
  tenant: String(grant.tenant),
  grantId: String(grant.grantId),
  credentialId: String(grant.credentialId),
  credentialRef: grant.credentialRef,
  actorSubject: String(grant.actorSubject),
  effectiveSubject: String(grant.effectiveSubject),
  scopeVersion: String(grant.scopeVersion),
  delegation: grant,
});

/** Identity layer for both human Access browser assertions and delegated Access
 * app assertions. An app assertion with no delegation mapping preserves the
 * existing machine principal for compatibility. Once a tuple has ever mapped,
 * every mismatch, expiry, revocation, or storage failure fails closed. */
export const makeCloudflareDelegatingIdentityLayer = (
  dbHandle: Pick<ExecutorDbHandle, "db">,
  config: CloudflareConfig,
  registry: VerifiedHumanSubjectRegistry,
  options: AccessVerifierOptions = {},
): Layer.Layer<IdentityProvider> => {
  const { verifyWithClaims } = makeAccessVerifier(config, options);
  return Layer.succeed(IdentityProvider)({
    authenticate: (request) =>
      Effect.gen(function* () {
        const verified = yield* verifyWithClaims(request);
        if (!verified) return yield* new Unauthorized();
        if (classifyAccessClaims(verified.claims) !== "service-token") {
          return verified.principal;
        }
        const credential = delegatedCredentialFromAccessClaims(verified.claims, config);
        if (credential === null) return yield* new Unauthorized();
        const service = makeCloudflareDelegationService(
          dbHandle,
          config,
          makeCloudflareDelegationAuthority(config, registry, request, options),
        );
        return yield* service.resolve(credential).pipe(
          Effect.map((grant) => delegatedPrincipalFrom(grant, config)),
          Effect.catchTag("DelegationDeniedError", (error) =>
            error.reason === "unmapped"
              ? Effect.succeed(verified.principal)
              : Effect.fail(new Unauthorized()),
          ),
          Effect.mapError(() => new Unauthorized()),
        );
      }),
  });
};
