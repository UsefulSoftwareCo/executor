import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";

import { AuthContext } from "@executor-js/api/server";
import { env } from "cloudflare:workers";
import { WorkOSClient } from "../auth/workos";
import { AutumnService } from "../extensions/billing/service";
import { resolveOrganization } from "../auth/organization";
import { Forbidden, OrgHttpApi } from "./api";

// ---------------------------------------------------------------------------
// Cloud-local org handlers — WorkOS domain-verification only. Members / roles /
// invite / org-name are served by the shared WorkOS `AccountProvider` over
// `/account/*`; this group covers the cloud-only domain endpoints behind
// `OrgAuth` (org-scoped cookie session).
// ---------------------------------------------------------------------------

const requireAdmin = Effect.gen(function* () {
  const auth = yield* AuthContext;
  const workos = yield* WorkOSClient;
  const currentMembership = yield* workos.getUserOrgMembership(auth.organizationId, auth.accountId);
  if (!currentMembership || currentMembership.role?.slug !== "admin") {
    return yield* new Forbidden();
  }
});

// Target-ownership check — independent of caller privilege. `requireAdmin`
// confirms the caller is an admin of their session's org; this confirms the
// domain they're about to delete actually lives in that same org. Without it,
// an admin of org A who obtained a domain id from org B (leak, screenshot,
// support context) could trigger the WorkOS SDK against org B's resource — the
// workspace API key is workspace-wide and WorkOS does not enforce per-org
// ownership on delete by id. Failures (not found OR org mismatch) both surface
// as Forbidden so we don't leak existence of ids outside the caller's org.
const assertDomainInSessionOrg = (domainId: string) =>
  Effect.gen(function* () {
    const auth = yield* AuthContext;
    const workos = yield* WorkOSClient;
    const domain = yield* workos
      .getOrganizationDomain(domainId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (!domain || domain.organizationId !== auth.organizationId) {
      return yield* new Forbidden();
    }
  });

export const OrgHandlers = HttpApiBuilder.group(OrgHttpApi, "org", (handlers) =>
  handlers
    .handle("listDomains", () =>
      Effect.gen(function* () {
        const auth = yield* AuthContext;
        const workos = yield* WorkOSClient;
        const org = yield* workos.getOrganization(auth.organizationId);

        const domains = yield* Effect.all(
          org.domains.map((d) =>
            Effect.gen(function* () {
              const full = yield* workos.getOrganizationDomain(d.id);
              return {
                id: full.id,
                domain: full.domain,
                state: full.state,
                verificationToken: full.verificationToken,
                verificationPrefix: full.verificationPrefix,
              };
            }),
          ),
          { concurrency: 5 },
        );

        return { domains };
      }),
    )
    .handle("getDomainVerificationLink", () =>
      Effect.gen(function* () {
        yield* requireAdmin;
        const auth = yield* AuthContext;

        const autumn = yield* AutumnService;
        const check = yield* autumn
          .use((client) =>
            client.check({
              customerId: auth.organizationId,
              featureId: "domain-verification",
            }),
          )
          .pipe(Effect.orElseSucceed(() => ({ allowed: false })));

        if (!check.allowed) {
          return yield* new Forbidden();
        }

        const org = yield* resolveOrganization(auth.organizationId).pipe(
          Effect.catchCause(() => Effect.succeed(null)),
        );
        const returnPath = org?.slug ? `/${org.slug}/org` : "/org";
        const workos = yield* WorkOSClient;
        // WorkOS requires an absolute returnUrl. Keep the URL org slug in that
        // return path so the browser comes back to the same selected org.
        const { link } = yield* workos.generateDomainVerificationPortalLink(
          auth.organizationId,
          `${env.VITE_PUBLIC_SITE_URL ?? "https://executor.sh"}${returnPath}`,
        );
        return { link };
      }),
    )
    .handle("deleteDomain", ({ params }) =>
      Effect.gen(function* () {
        yield* requireAdmin;
        yield* assertDomainInSessionOrg(params.domainId);
        const workos = yield* WorkOSClient;
        yield* workos.deleteOrganizationDomain(params.domainId);
        return { success: true };
      }),
    ),
);
