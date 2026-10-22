import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Layer } from "effect";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";

import { collectTables, Subject, type VerifiedHumanSubjectRegistry } from "@executor-js/sdk";
import {
  DelegationProvider,
  IdentityProvider,
  type DelegationRequestContext,
} from "@executor-js/api/server";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";

import type { CloudflareConfig } from "../config";
import { cloudflareDelegationProvider } from "../account/account-provider";
import { makeCloudflareDelegationAuthority, makeCloudflareDelegationService } from "./delegation";
import { makeCloudflareDelegatingIdentityLayer } from "./identity";

const config: CloudflareConfig = {
  accessTeamDomain: "team.cloudflareaccess.com",
  accessAud: "aud-tag",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  adminEmails: ["admin@example.com"],
  organizationId: "default",
  organizationName: "Default",
  organizationSlug: "default",
  secretKey: "x".repeat(32),
  allowLocalNetwork: false,
  webBaseUrl: "https://console.example",
  enableDevAuth: false,
  delegatedIssuanceEnabled: true,
  delegatedRecentAuthMaxAgeMs: 300_000,
  delegatedMaxTtlMs: 90 * 24 * 60 * 60 * 1000,
};

const scope = {
  actions: ["discover", "invoke"] as const,
  toolkitMembership: [
    {
      toolkitId: "toolkit-one",
      revision: "revision-one",
      toolAddresses: ["org.integration.connection.tool"],
      connectionAddresses: ["org.integration.connection"],
    },
  ],
  toolAddresses: ["org.integration.connection.tool"],
  connectionAddresses: ["org.integration.connection"],
};

const subjects = new Set(["human-admin", "human-target"]);

const registry: VerifiedHumanSubjectRegistry = {
  isVerifiedHuman: ({ subject }) => Effect.succeed(subjects.has(subject)),
  markVerifiedHuman: ({ subject }) => {
    subjects.add(subject);
    return Effect.void;
  },
  revokeVerifiedHuman: ({ subject }) => {
    subjects.delete(subject);
    return Effect.void;
  },
};

const signedAccessRequest = async (
  privateKey: KeyLike,
  claims: Readonly<Record<string, unknown>>,
): Promise<Request> => {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "delegation-test" })
    .setIssuer("https://team.cloudflareaccess.com")
    .setAudience("aud-tag")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
  return new Request("https://console.example/api/account", {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });
};

describe("Cloudflare delegated Access flow", () => {
  it.effect("allows an originless human GET and blocks a cross-origin mutation", () =>
    Effect.promise(async () => {
      const { privateKey, publicKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      const keySet = createLocalJWKSet({
        keys: [{ ...jwk, alg: "RS256", kid: "delegation-test" }],
      });
      const humanRequest = await signedAccessRequest(privateKey, {
        sub: "new-human",
        email: "new-human@example.com",
        name: "New Human",
        auth_time: Math.floor(Date.now() / 1000) - 30,
      });
      const subjects = new Set<string>();
      const humanRegistry: VerifiedHumanSubjectRegistry = {
        isVerifiedHuman: ({ subject }) => Effect.succeed(subjects.has(subject)),
        markVerifiedHuman: ({ subject }) => {
          subjects.add(subject);
          return Effect.void;
        },
        revokeVerifiedHuman: ({ subject }) => {
          subjects.delete(subject);
          return Effect.void;
        },
      };
      const db = await createSqliteTestFumaDb({ tables: collectTables() });
      const noOriginConfig: CloudflareConfig = { ...config, webBaseUrl: undefined };
      await Effect.runPromise(
        Effect.acquireUseRelease(
          Effect.succeed(db),
          (owned) =>
            Effect.promise(async () => {
              const context = await Effect.runPromise(
                Effect.scoped(
                  Layer.build(
                    cloudflareDelegationProvider(owned, noOriginConfig, humanRegistry, { keySet }),
                  ),
                ),
              );
              const provider = Context.get(context, DelegationProvider);
              const headers = Object.fromEntries(humanRequest.headers.entries());
              const browserRead = {
                headers,
                requestOrigin: "https://victim.example",
                browserOrigin: null,
                method: "GET",
              } satisfies DelegationRequestContext;
              const targets = await Effect.runPromise(provider.listDelegationTargets(browserRead));
              expect(targets.targets).toHaveLength(1);
              expect(targets.targets[0]?.id).toBe("new-human");
              expect(subjects.has("new-human")).toBe(true);

              const crossOriginMutation = {
                ...browserRead,
                browserOrigin: "https://evil.example",
                method: "POST",
              } satisfies DelegationRequestContext;
              const denied = await Effect.runPromiseExit(
                provider.listDelegationTargets(crossOriginMutation),
              );
              expect(Exit.isFailure(denied)).toBe(true);
            }),
          (owned) => Effect.promise(() => owned.close()),
        ),
      );
    }),
  );

  it.effect("proves possession, requires human consent, and revokes without fallback", () =>
    Effect.promise(async () => {
      const { privateKey, publicKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      const keySet = createLocalJWKSet({
        keys: [{ ...jwk, alg: "RS256", kid: "delegation-test" }],
      });
      const humanRequest = await signedAccessRequest(privateKey, {
        sub: "human-admin",
        email: "admin@example.com",
        name: "Admin",
        auth_time: Math.floor(Date.now() / 1000) - 30,
      });
      const machineRequest = await signedAccessRequest(privateKey, {
        type: "app",
        common_name: "machine-one",
      });
      const staleHumanRequest = await signedAccessRequest(privateKey, {
        sub: "human-admin",
        email: "admin@example.com",
        auth_time:
          Math.floor(Date.now() / 1000) - Math.ceil(config.delegatedRecentAuthMaxAgeMs / 1000) - 1,
      });
      const machineCredential = {
        kind: "external" as const,
        adapter: "cloudflare-access",
        issuer: "https://team.cloudflareaccess.com",
        audience: "aud-tag",
        subject: "machine-one",
        credentialRef: "machine-one",
      };
      const db = await createSqliteTestFumaDb({ tables: collectTables() });
      const run = async () => {
        const humanAuthority = makeCloudflareDelegationAuthority(config, registry, humanRequest, {
          keySet,
        });
        const machineAuthority = makeCloudflareDelegationAuthority(
          config,
          registry,
          machineRequest,
          { keySet },
        );
        const staleHumanAuthority = makeCloudflareDelegationAuthority(
          config,
          registry,
          staleHumanRequest,
          { keySet },
        );
        const humanService = makeCloudflareDelegationService(db, config, humanAuthority);
        const machineService = makeCloudflareDelegationService(db, config, machineAuthority);

        const challenge = await Effect.runPromise(
          humanService.issueProofChallenge({
            adapter: "cloudflare-access",
            createdBy: Subject.make("human-admin"),
            effectiveSubject: Subject.make("human-target"),
            label: "Cloudflare agent",
            scope,
          }),
        );
        const completion = await Effect.runPromise(
          machineService.completeProofChallenge({
            challengeId: challenge.challengeId,
            credential: machineCredential,
            machineActor: Subject.make("access:machine-one"),
            nonce: challenge.nonce,
          }),
        );
        expect(completion.credential.credentialRef).toBe("machine-one");

        const grant = await Effect.runPromise(
          humanService.create({
            proofChallengeId: challenge.challengeId,
            consentedBy: Subject.make("human-admin"),
          }),
        );
        const resolved = await Effect.runPromise(machineService.resolve(machineCredential));
        expect(resolved.grantId).toBe(grant.grantId);
        const identityAuthority = makeCloudflareDelegationAuthority(
          config,
          registry,
          machineRequest,
          { keySet },
        );
        expect(await Effect.runPromise(identityAuthority.isCurrentlyAuthorized(grant))).toBe(true);
        const identityService = makeCloudflareDelegationService(db, config, identityAuthority);
        const identityServiceResolved = await Effect.runPromiseExit(
          identityService.resolve(machineCredential),
        );
        expect(Exit.isSuccess(identityServiceResolved)).toBe(true);
        const identityContext = await Effect.runPromise(
          Effect.scoped(
            Layer.build(makeCloudflareDelegatingIdentityLayer(db, config, registry, { keySet })),
          ),
        );
        const identity = Context.get(identityContext, IdentityProvider);
        const delegatedPrincipal = await Effect.runPromise(
          identity.authenticate(
            new Request(machineRequest.url, { headers: new Headers(machineRequest.headers) }),
          ),
        );
        expect(delegatedPrincipal.kind).toBe("delegated");
        expect(
          await Effect.runPromise(
            humanAuthority.isManagementAuthorized(
              Subject.make("human-admin"),
              Subject.make("human-target"),
            ),
          ),
        ).toBe(true);
        expect(
          await Effect.runPromise(
            machineAuthority.isManagementAuthorized(
              Subject.make("human-admin"),
              Subject.make("human-target"),
            ),
          ),
        ).toBe(false);
        expect(
          await Effect.runPromise(
            staleHumanAuthority.isManagementAuthorized(
              Subject.make("human-admin"),
              Subject.make("human-target"),
            ),
          ),
        ).toBe(false);

        await Effect.runPromise(
          humanService.revoke({
            grantId: grant.grantId,
            actorSubject: Subject.make("human-admin"),
          }),
        );
        const revoked = await Effect.runPromiseExit(machineService.resolve(machineCredential));
        expect(Exit.isFailure(revoked)).toBe(true);
        const differentMachine = await Effect.runPromiseExit(
          machineService.resolve({ ...machineCredential, credentialRef: "machine-two" }),
        );
        expect(Exit.isFailure(differentMachine)).toBe(true);
        const revokedIdentity = await Effect.runPromiseExit(identity.authenticate(machineRequest));
        expect(Exit.isFailure(revokedIdentity)).toBe(true);
        const unmappedIdentity = await Effect.runPromiseExit(
          identity.authenticate(
            await signedAccessRequest(privateKey, {
              type: "app",
              common_name: "machine-two",
            }),
          ),
        );
        expect(Exit.isSuccess(unmappedIdentity)).toBe(true);
        const unmappedPrincipal = Exit.match(unmappedIdentity, {
          onFailure: () => null,
          onSuccess: (value) => value,
        });
        expect(unmappedPrincipal).toMatchObject({ kind: "member", accountId: "machine-two" });
      };
      await Effect.runPromise(
        Effect.acquireUseRelease(
          Effect.succeed(db),
          () => Effect.promise(run),
          (owned) => Effect.promise(() => owned.close()),
        ),
      );
    }),
  );
});
