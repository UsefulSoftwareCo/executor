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
  type OrganizationId,
} from "@executor-js/hosted-server";
import { SetupOrder, SetupSkip, type SetupStep } from "@executor-js/hosted-server/setup";
import {
  TeamIconOwner,
  CompanyLookup,
  CompanyProfile,
  Onboarding,
  OnboardingUnavailable,
  CreateTeam,
  type OnboardingCreated,
  TeamIconNotFound,
  onboardingExperiment,
  onboardingSkipExperiment,
  SetupGate,
} from "../contracts/onboarding.ts";
import { FeatureFlags } from "./feature-flags.ts";
import { makeOnboardingStore } from "./onboarding-store.ts";
import { recordFlagExposure } from "./product-analytics.ts";

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
  /** The one entry decision: existing membership, a pending invitation, then earlier setup. */
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
      // Settle existing membership before storing an icon, and before the transaction: no SQL
      // transaction stays open during R2 I/O.
      const entry = yield* standing(userId);
      if (entry.status !== "new") return entry;
      const details = {
        name: selected.name,
        logo: Schema.is(UploadedOrganizationIcon)(selected.logo)
          ? yield* saveIcon(userId, selected.logo)
          : selected.logo,
      };
      // Whether this request created the team, rather than finding one an earlier one created.
      const { entry: confirmed, created } = yield* store
        .transaction(
          Effect.gen(function* () {
            const found = (entry: typeof OnboardingCreated.Type) => ({ entry, created: undefined });
            const user = yield* store.lockUser(userId);
            if (!user?.emailVerified) return yield* new OnboardingUnavailable();
            const state = yield* store.state(userId, user.email);
            if (state.organizations.length > 0)
              return found({ status: "ready", organizations: state.organizations });
            if (state.invitation !== null)
              return found({ status: "invitation", invitation: state.invitation });
            if (state.provisioned) return found({ status: "ready", organizations: [] });
            const base = teamSlug(details.name);
            for (let attempt = 0; attempt < 5; attempt++) {
              const slug =
                attempt === 0
                  ? base
                  : `${base}-${yield* Effect.sync(() => crypto.randomUUID().slice(0, 6))}`;
              const organizations = yield* store.create(userId, details, slug);
              const [team] = organizations;
              if (organizations.length === 1 && team !== undefined)
                return { entry: { status: "ready" as const, organizations }, created: team.id };
            }
            return yield* new OnboardingUnavailable();
          }),
        )
        .pipe(recoverSetupConnection);
      if (created === undefined || selected.next !== "setup" || confirmed.status !== "ready")
        return confirmed;
      yield* assignSetup(userId, created);
      // The browser opens the first step straight away, so the setup is read, and any exposures
      // recorded, as that step is shown. A failed read leaves the step to read it.
      const sequence = yield* setup(userId, created).pipe(Effect.option);
      return Option.isSome(sequence) ? { ...confirmed, setup: sequence.value } : confirmed;
    }).pipe(
      Effect.mapError(() => new OnboardingUnavailable()),
      Effect.withSpan("onboarding.create"),
    );
  /**
   * Ask PostHog, in one evaluation, for the new team's setup order and whether its steps can be
   * skipped, and keep each answer, so every later read shows the same setup. The two experiments
   * are independent: an unavailable flag, or a failure keeping its answer, leaves the member
   * unassigned in that experiment only, where they see its control and are not counted. Creating
   * the team never waits on more than the evaluation's one-second deadline and never fails
   * because of it.
   */
  const assignSetup = (userId: string, organization: string) =>
    Effect.gen(function* () {
      const flags = yield* FeatureFlags;
      const answers = yield* flags.evaluate(
        [onboardingExperiment.flag, onboardingSkipExperiment.flag],
        userId,
      );
      const order = Schema.decodeUnknownOption(SetupOrder)(answers[onboardingExperiment.flag]);
      if (Option.isSome(order))
        yield* store
          .assignSetup(userId, organization, order.value)
          .pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "Setup order was not assigned; the team sees the control untracked",
              ),
            ),
          );
      const skip = Schema.decodeUnknownOption(SetupSkip)(answers[onboardingSkipExperiment.flag]);
      if (Option.isSome(skip))
        yield* store
          .assignSkip(userId, organization, skip.value)
          .pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "Setup skip was not assigned; the member sees the control untracked",
              ),
            ),
          );
    });
  /** Exactly one read marks an assignment seen, so each exposure is recorded once. */
  const exposure = (
    userId: string,
    organization: OrganizationId,
    flag: string,
    claimed: string | undefined,
  ) =>
    claimed === undefined
      ? Effect.void
      : recordFlagExposure({ userId, organizationId: organization, flag, variant: claimed });
  const setup: typeof Onboarding.Service.setup = (userId, organization) =>
    Effect.gen(function* () {
      const exposedOrder = yield* store.claimSetupExposure(userId, organization);
      yield* exposure(userId, organization, onboardingExperiment.flag, exposedOrder);
      const exposedSkip = yield* store.claimSkipExposure(userId, organization);
      yield* exposure(userId, organization, onboardingSkipExperiment.flag, exposedSkip);
      const order = exposedOrder ?? (yield* store.setupAssignment(userId, organization));
      const skip = exposedSkip ?? (yield* store.skipAssignment(userId, organization))?.variant;
      return {
        order: order ?? onboardingExperiment.control,
        enrolled: order !== undefined,
        skip: {
          variant: skip ?? onboardingSkipExperiment.control,
          enrolled: skip !== undefined,
        },
      };
    }).pipe(
      Effect.mapError(() => new OnboardingUnavailable()),
      Effect.withSpan("onboarding.setup"),
    );
  const gate: typeof Onboarding.Service.gate = (userId, organization, progress) =>
    Effect.gen(function* () {
      const assigned = yield* store.skipAssignment(userId, organization);
      if (assigned === undefined || assigned.variant !== "required" || assigned.completed)
        return SetupGate.make({ status: "open" });
      const done = yield* progress;
      if (done.accounts && done.agent !== undefined) {
        yield* store.completeSetup(userId, organization);
        return SetupGate.make({ status: "open" });
      }
      const order =
        (yield* store.setupAssignment(userId, organization)) ?? onboardingExperiment.control;
      // The next step is the first of the member's order that is not done.
      const first: SetupStep = order === "assistant_first" ? "assistant" : "accounts";
      const firstDone = first === "accounts" ? done.accounts : done.agent !== undefined;
      const step: SetupStep = firstDone ? (first === "accounts" ? "assistant" : "accounts") : first;
      // The account step carries a connected assistant on to the first prompt.
      return step === "accounts" && done.agent !== undefined
        ? SetupGate.make({ status: "setup", step, agent: done.agent })
        : SetupGate.make({ status: "setup", step });
    }).pipe(
      Effect.mapError(() => new OnboardingUnavailable()),
      Effect.withSpan("onboarding.gate"),
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
  return Onboarding.of({ prepare, create, setup, gate, icon });
});
