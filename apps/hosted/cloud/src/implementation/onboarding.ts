import { Effect, Option, Result, Schedule, Schema } from "effect";
import { BlobKey, BlobStore } from "@executor-js/sdk/core";
import {
  UploadedOrganizationIcon,
  OrganizationIconKey,
  organizationIconContentType,
} from "@executor-js/hosted-server/organization-icon";
import { SqlError } from "effect/sql";
import {
  OrganizationLogo,
  organizationHandle,
  organizationSlugMaxLength,
} from "@executor-js/hosted-server";
import {
  TeamIconOwner,
  CompanyLookup,
  CompanyProfile,
  Onboarding,
  OnboardingUnavailable,
  CreateTeam,
  TeamIconNotFound,
  V1Membership,
} from "../contracts/onboarding.ts";
import { makeOnboardingStore } from "./onboarding-store.ts";

const companyDomain = (email: string): string | null => {
  const parts = email.toLowerCase().split("@");
  const domain = parts.length === 2 ? parts[1] : undefined;
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || domain.endsWith("noreply.github.com"))
    return null;
  return domain;
};
const emailTeamName = (email: string) => {
  const local = email.slice(0, email.indexOf("@")).split("+")[0] ?? "";
  return (
    local
      .replace(/[._-]+/g, " ")
      .trim()
      .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase())
      .slice(0, 120) || "My team"
  );
};
const teamSlug = (name: string) =>
  organizationHandle(name, organizationSlugMaxLength - 7) || "team";

/** Retry an idempotent setup only after the failed SQL transaction has released its connection. */
export const recoverSetupConnection = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.spaced("100 millis"),
      while: (error) =>
        SqlError.isSqlError(error) && Schema.is(SqlError.ConnectionError)(error.reason),
    }),
  );

/** Prepare suggestions before confirmation; only create writes organization identity. */
export const makeOnboarding = Effect.fn("onboarding.service")(function* (options: {
  readonly origin: string;
}) {
  const blobs = yield* BlobStore;
  const store = yield* makeOnboardingStore;
  const lookup = yield* CompanyLookup;
  const v1 = yield* V1Membership;
  const iconUrl = (owner: string, key: string) =>
    new URL(`/api/onboarding/icons/${owner}/${key}`, options.origin).href;
  const iconKey = (owner: string, key: string) => BlobKey.make(`team-icons/${owner}/${key}`);
  const saveIcon = (owner: string, upload: UploadedOrganizationIcon) =>
    Effect.gen(function* () {
      const safeOwner = yield* Schema.decodeUnknownEffect(TeamIconOwner)(owner);
      const digest = yield* Effect.tryPromise(() =>
        crypto.subtle.digest("SHA-256", new Uint8Array(upload.bytes).buffer),
      );
      const key = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      // Content addressing makes retries safe. No SQL transaction stays open during R2 I/O.
      yield* blobs.put(iconKey(safeOwner, key), upload.bytes);
      return iconUrl(safeOwner, key);
    });
  const suggestCompany = (domain: string) =>
    Effect.gen(function* () {
      const saved = yield* store.company(domain);
      if (saved?.status === "ready" && saved.profile !== null)
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CompanyProfile))(
          saved.profile,
        );
      if (saved?.status === "unavailable") return null;
      const lease = yield* Effect.sync(() => crypto.randomUUID());
      if (!(yield* store.claimCompany(domain, lease))) return null;
      const result = yield* lookup.lookup(domain).pipe(Effect.timeout("2 seconds"), Effect.result);
      if (Result.isSuccess(result)) {
        yield* store.saveCompany(domain, lease, result.success);
        return result.success;
      }
      yield* store.releaseCompany(domain, lease);
      yield* Effect.logWarning(
        "Company suggestion unavailable; team confirmation remains available",
      );
      return null;
    });
  /**
   * The one entry decision: existing membership, a pending invitation and earlier setup come
   * first; only an account with none of them asks v1. Runs no SQL transaction, so the WorkOS
   * read never holds one open.
   */
  const standing = (userId: string) =>
    Effect.gen(function* () {
      const user = yield* store.user(userId);
      if (!user?.emailVerified) return yield* new OnboardingUnavailable();
      const state = yield* store.state(userId, user.email);
      if (state.organizations.length > 0)
        return { status: "ready" as const, organizations: state.organizations };
      if (state.invitation !== null)
        return { status: "invitation" as const, invitation: state.invitation };
      if (state.provisioned) return { status: "ready" as const, organizations: [] };
      // Only a verified email reaches this point, so the answer cannot reveal another person's v1 account.
      if ((yield* v1.check(user)) === "v1") return { status: "v1" as const };
      return { status: "new" as const, user };
    });
  const prepare: typeof Onboarding.Service.prepare = (userId) =>
    Effect.gen(function* () {
      const entry = yield* standing(userId);
      if (entry.status !== "new") return entry;
      const { user } = entry;
      const domain = companyDomain(user.email);
      const profile = domain === null ? null : yield* suggestCompany(domain);
      return {
        status: "draft" as const,
        suggestion: {
          name: profile?.name ?? emailTeamName(user.email),
          logo: profile?.logo ?? (Schema.is(OrganizationLogo)(user.image) ? user.image : null),
        },
      };
    }).pipe(
      Effect.mapError(() => new OnboardingUnavailable()),
      Effect.withSpan("onboarding.prepare"),
    );

  const create: typeof Onboarding.Service.create = (userId, input) =>
    Effect.gen(function* () {
      const selected = yield* Schema.decodeUnknownEffect(Schema.toType(CreateTeam))({
        ...input,
        name: input.name.trim(),
      });
      // Settle existing membership and the v1 check before storing an icon, and before the
      // transaction: no SQL transaction stays open during WorkOS or R2 I/O.
      const entry = yield* standing(userId);
      if (entry.status !== "new") return entry;
      const details = {
        name: selected.name,
        logo: Schema.is(UploadedOrganizationIcon)(selected.logo)
          ? yield* saveIcon(userId, selected.logo)
          : selected.logo,
      };
      return yield* store
        .transaction(
          Effect.gen(function* () {
            const user = yield* store.lockUser(userId);
            if (!user?.emailVerified) return yield* new OnboardingUnavailable();
            const state = yield* store.state(userId, user.email);
            if (state.organizations.length > 0)
              return { status: "ready" as const, organizations: state.organizations };
            if (state.invitation !== null)
              return { status: "invitation" as const, invitation: state.invitation };
            if (state.provisioned) return { status: "ready" as const, organizations: [] };
            const base = teamSlug(details.name);
            for (let attempt = 0; attempt < 5; attempt++) {
              const slug =
                attempt === 0
                  ? base
                  : `${base}-${yield* Effect.sync(() => crypto.randomUUID().slice(0, 6))}`;
              const organizations = yield* store.create(userId, details, slug);
              if (organizations.length === 1) return { status: "ready" as const, organizations };
            }
            return yield* new OnboardingUnavailable();
          }),
        )
        .pipe(recoverSetupConnection);
    }).pipe(
      Effect.mapError(() => new OnboardingUnavailable()),
      Effect.withSpan("onboarding.create"),
    );
  const icon: typeof Onboarding.Service.icon = (userId, owner, key) =>
    Effect.gen(function* () {
      const safeOwner = yield* Schema.decodeUnknownEffect(TeamIconOwner)(owner);
      const safeKey = yield* Schema.decodeUnknownEffect(OrganizationIconKey)(key);
      if (!(yield* store.canReadIcon(userId, safeOwner, iconUrl(safeOwner, safeKey))))
        return yield* new TeamIconNotFound();
      const bytes = yield* blobs.get(iconKey(safeOwner, safeKey));
      if (Option.isNone(bytes)) return yield* new TeamIconNotFound();
      const contentType = organizationIconContentType(bytes.value);
      if (contentType === undefined) return yield* new OnboardingUnavailable();
      return { bytes: bytes.value, contentType };
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(TeamIconNotFound)(error) ? error : new OnboardingUnavailable(),
      ),
    );
  /**
   * Creating an organization needs the account's own pass of the v1 check, whatever its v2
   * memberships and invitations: an invitation lets a v1 member join the inviting organization,
   * not start another. Setting up a team through onboarding ran the check (or the account
   * predates it), so such an account is not asked again; any other account asks v1 now.
   * Accounts created before the check shipped skip it (`V1Membership`).
   */
  const allowsOrganization: typeof Onboarding.Service.allowsOrganization = (userId) =>
    Effect.gen(function* () {
      const user = yield* store.user(userId);
      if (!user?.emailVerified) return yield* new OnboardingUnavailable();
      if (yield* store.setUpTeam(userId)) return true;
      return (yield* v1.check(user)) !== "v1";
    }).pipe(
      Effect.mapError(() => new OnboardingUnavailable()),
      Effect.withSpan("onboarding.allowsOrganization"),
    );
  return Onboarding.of({ prepare, create, allowsOrganization, icon });
});
