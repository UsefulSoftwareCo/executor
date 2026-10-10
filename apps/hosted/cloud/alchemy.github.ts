/**
 * CI configuration plane: repository settings, deployment environments, the CI Cloudflare
 * token, the protected-branch ruleset, and the public export. Development happens in this
 * private repository; `.github/workflows/export-public.yml` snapshots `main` to the public
 * repository's export branch. This stack places the token that workflow pushes with and
 * protects the export branch on the public repository.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import { retain } from "alchemy/RemovalPolicy";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import { stackState } from "./src/infrastructure/state.ts";
import { productionSocialCallbackOrigin } from "./src/infrastructure/deploy-settings.ts";
import { BrowserOrigin, browserOriginSetting } from "./src/infrastructure/stage.ts";
import {
  CheckSince,
  missingV1PlanetscaleDatabase,
  missingV1MembershipCheckSince,
  missingV1WorkosKey,
} from "./src/infrastructure/v1-membership-settings.ts";

/**
 * Secrets seeded from the environment. `op run --env-file=.env.ci.op` resolves the 1Password
 * references; the resolved values never reach disk, state, or stack outputs.
 *
 * GitHub Actions rejects secret and variable names that start with `GITHUB_`, so the login
 * client uses the `AUTH_GITHUB_` prefix. Workflows map it back to the variable the cloud
 * stack reads: `GITHUB_CLIENT_ID: ${{ secrets.AUTH_GITHUB_CLIENT_ID }}`.
 */
const productionSecrets = [
  "AUTH_GITHUB_CLIENT_ID",
  "AUTH_GITHUB_CLIENT_SECRET",
  "AUTUMN_SECRET_KEY",
  "AXIOM_TOKEN",
  "BETTER_AUTH_SECRET",
  "CHATGPT_CLIENT_ID",
  "CHATGPT_CLIENT_SECRET",
  "CONTEXT_DEV_API_KEY",
  "EXECUTOR_ENCRYPTION_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "OAUTH_PROXY_SECRET",
  "PLANETSCALE_API_TOKEN",
  "PLANETSCALE_API_TOKEN_ID",
  "POSTHOG_PERSONAL_API_KEY",
  "SENTRY_AUTH_TOKEN",
] as const;

/** Non-sensitive deployment settings. They are readable in logs and pull requests. */
const productionVariables = [
  "AUTH_EMAIL_DOMAIN",
  "AUTH_EMAIL_PROVISION_SUBDOMAIN",
  "AUTH_TRUSTED_ORIGINS",
  "AUTUMN_SERVER_URL",
  "AXIOM_ORG_ID",
  "BETTER_AUTH_URL",
  "CLOUDFLARE_ZONE_ID",
  "CLOUD_PLACEMENT_REGION",
  "EXECUTOR_APP_UI_BASE_URL",
  "PLANETSCALE_CLUSTER_SIZE",
  "PLANETSCALE_DATABASE_NAME",
  "PLANETSCALE_ORGANIZATION",
  "PLANETSCALE_REGION",
  "POSTHOG_ENABLED",
  "POSTHOG_HOST",
  "POSTHOG_INGEST_HOST",
  "POSTHOG_INTERNAL_USER_IDS",
  "POSTHOG_ORGANIZATION_ID",
  "SENTRY_ENABLED",
  "SENTRY_ORG",
  "SENTRY_TEAM",
  "SENTRY_URL",
] as const;

/**
 * Required status checks on `main`. These are the contexts reported by `ci.yml` calling
 * `checks.yml` (PR #246). The E2E jobs run as matrix runners whose names change with the
 * selection, so `checks / e2e` stands for all of them. `CI_RULESET_ENFORCEMENT` defaults to `active`, so an apply that
 * cannot create the ruleset fails loudly rather than leaving `main` silently unprotected.
 * Rulesets need GitHub Pro on a private repository, which is the blocker today; `.env.ci.op`
 * sets `disabled` until the plan allows them. `evaluate` is log only and blocks nothing.
 */
const requiredStatusChecks = ["checks / check", "checks / e2e"] as const;

export default Alchemy.Stack(
  "executor-next-ci",
  {
    providers: Layer.mergeAll(GitHub.providers(), Cloudflare.providers()),
    // The `ci` stage shares the account state store with every other deployed stage.
    state: stackState,
  },
  Effect.gen(function* () {
    const owner = yield* Config.NonEmptyString("GITHUB_OWNER");
    const name = yield* Config.NonEmptyString("GITHUB_REPOSITORY_NAME");
    const accountId = yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
    const publicName = yield* Config.NonEmptyString("PUBLIC_GITHUB_REPOSITORY_NAME").pipe(
      Config.withDefault("executor"),
    );
    const publicBranch = yield* Config.NonEmptyString("PUBLIC_EXPORT_BRANCH").pipe(
      Config.withDefault("v2"),
    );
    const runnerMode = yield* Config.Literals(["blacksmith", "desktop"], "CI_RUNNER_MODE").pipe(
      Config.withDefault("blacksmith" as const),
    );
    const enforcement = yield* Config.Literals(
      ["evaluate", "active", "disabled"],
      "CI_RULESET_ENFORCEMENT",
    ).pipe(Config.withDefault("active" as const));

    // The repository already exists. Alchemy observes it and converges these settings only;
    // every property it does not declare keeps its current value.
    const repository = yield* GitHub.Repository("Repository", {
      owner,
      name,
      description: "Executor SDK, app framework, and local product",
      visibility: "private",
      defaultBranch: "main",
      hasIssues: true,
      hasProjects: true,
      hasWiki: false,
      hasDiscussions: false,
      // Squash is the only merge strategy: one commit per pull request on main.
      allowSquashMerge: true,
      allowMergeCommit: false,
      allowRebaseMerge: false,
      allowAutoMerge: false,
      deleteBranchOnMerge: true,
    }).pipe(retain());

    const target = { owner, repository: name };

    /**
     * The `production` and `release` environments exist but are not Alchemy resources. Alchemy's
     * Environment provider always sends protection-rule fields, and GitHub rejects those for a
     * private repository on the Free plan. Create each once with a bare upsert, which the plan
     * accepts: `gh api -X PUT repos/<owner>/<name>/environments/production`. Secrets and
     * variables scope to the environment by name.
     */
    const production = "production";

    /**
     * The CI deployment token. Cloudflare returns its value once, on creation, so Alchemy is
     * the only place that can copy it into the GitHub secret. Cloudflare's API names the
     * "Edit" permission groups "Write". Zone permissions on an account-owned token nest
     * under the account resource.
     */
    const deployToken = yield* Cloudflare.ApiToken.AccountApiToken("DeployToken", {
      name: `executor-next-ci-${name}`,
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            // Request timing provisions a private native trace export destination.
            "Workers Observability Write",
            "Workers R2 Storage Write",
            // Workers connect to Postgres directly. Deleting the retired Hyperdrive
            // configurations still needs this; drop it once no stage has one.
            "Hyperdrive Write",
            "Account Settings Read",
            // The shared state store keeps its bearer token in the account Secrets Store.
            "Secrets Store Write",
            // The retired Hyperdrive CA upload is retained, not managed; drop with Hyperdrive Write.
            "Account: SSL and Certificates Write",
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
        {
          effect: "allow",
          permissionGroups: ["SSL and Certificates Write", "Workers Routes Write"],
          // Every zone in the account: the product zone (`executor.sh`), the app-page zone
          // (`executor.website`, wildcard Worker routes) and the test-stage zone.
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: {
              "com.cloudflare.api.account.zone.*": "*",
            },
          },
        },
      ],
    }).pipe(retain());

    // Repository scope: pull request workflows deploy test stages with the same credential.
    yield* GitHub.Secret("CloudflareApiToken", {
      ...target,
      name: "CLOUDFLARE_API_TOKEN",
      value: deployToken.value,
    }).pipe(retain());
    yield* GitHub.Variable("CloudflareAccountId", {
      ...target,
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: accountId,
    }).pipe(retain());

    // Secretless PR and main checks can run on the trusted desktop runner when requested.
    // Deployment, staging and release workflows intentionally keep their own Blacksmith
    // capacity because they hold credentials or require an OS-specific runner matrix.
    yield* GitHub.Variable("CiRunnerMode", {
      ...target,
      name: "CI_RUNNER_MODE",
      value: runnerMode,
    }).pipe(retain());

    /**
     * The public export token: a fine-grained token with `contents: write` on the public
     * repository only. GitHub cannot mint it through the API and the organization disables
     * deploy keys, so the value comes from 1Password. Repository scope, because the export
     * workflow runs on `main` outside any deployment environment.
     */
    yield* Config.Redacted("PUBLIC_EXPORT_TOKEN").pipe(
      Effect.flatMap((value) =>
        GitHub.Secret("PublicExportToken", {
          ...target,
          name: "PUBLIC_EXPORT_TOKEN",
          value,
        }).pipe(retain()),
      ),
    );

    yield* Effect.forEach(productionSecrets, (secret) =>
      Config.Redacted(secret).pipe(
        Effect.flatMap((value) =>
          GitHub.Secret(`production-${secret}`, {
            ...target,
            name: secret,
            value,
            environment: production,
          }).pipe(retain()),
        ),
      ),
    );

    yield* Effect.forEach(productionVariables, (variable) =>
      Config.NonEmptyString(variable).pipe(
        Effect.flatMap((value) =>
          GitHub.Variable(`production-${variable}`, {
            ...target,
            name: variable,
            value,
            environment: production,
          }).pipe(retain()),
        ),
      ),
    );

    /**
     * Where production's social sign-ins return, and so the OAuth proxy's production URL: the
     * edge on `executor.sh`, whichever host serves sign-in. It is fixed by the code, not by
     * `.env.ci.op`; the deploy refuses any other value (`deploy-settings.ts`).
     */
    yield* GitHub.Variable("production-OAUTH_PROXY_PRODUCTION_URL", {
      ...target,
      name: "OAUTH_PROXY_PRODUCTION_URL",
      value: productionSocialCallbackOrigin,
      environment: production,
    }).pipe(retain());

    /**
     * The rollback switch (`notes/cloud-domains.md`): `deployment` serves the dashboard and
     * sign-in on `v2.executor.sh` again. `.env.ci.op` sets it; unset is `app`, the cutover.
     */
    const browserOrigin: BrowserOrigin = yield* browserOriginSetting;
    yield* GitHub.Variable("production-CLOUD_BROWSER_ORIGIN", {
      ...target,
      name: "CLOUD_BROWSER_ORIGIN",
      value: browserOrigin,
      environment: production,
    }).pipe(retain());

    /**
     * The v1 sign-in check: v1's WorkOS API key, the name of v1's PlanetScale database (the
     * deploy creates a read-only role on it), and the instant the check shipped. Accounts created
     * before that instant skip it. Production requires all three, so this stack refuses to apply
     * without them and says what to set: the key's Agents vault reference, the database name,
     * and the cutoff, set in `.env.ci.op` at the merge that ships the check.
     */
    const v1Key = yield* Config.Redacted("V1_WORKOS_API_KEY").pipe(
      Config.option,
      Effect.map(Option.filter((value) => Redacted.value(value) !== "")),
    );
    if (Option.isNone(v1Key)) return yield* Effect.die(new Error(missingV1WorkosKey));
    const v1Since = yield* Config.String("V1_MEMBERSHIP_CHECK_SINCE").pipe(
      Config.option,
      Effect.map(
        Option.filter((value) => Option.isSome(Schema.decodeUnknownOption(CheckSince)(value))),
      ),
    );
    if (Option.isNone(v1Since)) return yield* Effect.die(new Error(missingV1MembershipCheckSince));
    const v1Database = yield* Config.String("V1_PLANETSCALE_DATABASE_NAME").pipe(
      Config.option,
      Effect.map(Option.filter((value) => value !== "")),
    );
    if (Option.isNone(v1Database))
      return yield* Effect.die(new Error(missingV1PlanetscaleDatabase));
    yield* GitHub.Secret("production-V1_WORKOS_API_KEY", {
      ...target,
      name: "V1_WORKOS_API_KEY",
      value: v1Key.value,
      environment: production,
    }).pipe(retain());
    yield* GitHub.Variable("production-V1_MEMBERSHIP_CHECK_SINCE", {
      ...target,
      name: "V1_MEMBERSHIP_CHECK_SINCE",
      value: v1Since.value,
      environment: production,
    }).pipe(retain());
    yield* GitHub.Variable("production-V1_PLANETSCALE_DATABASE_NAME", {
      ...target,
      name: "V1_PLANETSCALE_DATABASE_NAME",
      value: v1Database.value,
      environment: production,
    }).pipe(retain());

    // Rulesets are unavailable on private repositories under the GitHub Free plan, so
    // `CI_RULESET_ENFORCEMENT=disabled` skips the resource instead of asking GitHub for it.
    const ruleset =
      enforcement === "disabled"
        ? undefined
        : yield* GitHub.Ruleset("Main", {
            ...target,
            name: "main",
            enforcement,
            target: "branch",
            conditions: { include: ["refs/heads/main"] },
            // Administrators keep direct access while the workflow names are still settling.
            bypassActors: [{ actorType: "RepositoryRole", actorId: 5, bypassMode: "always" }],
            rules: {
              deletion: true,
              nonFastForward: true,
              requiredStatusChecks: {
                checks: requiredStatusChecks.map((context) => ({ context })),
                strictRequiredStatusChecksPolicy: false,
              },
              pullRequest: {
                requiredApprovingReviewCount: 0,
                requiredReviewThreadResolution: true,
              },
            },
          }).pipe(retain());

    /**
     * The export branch on the public repository only ever receives fast-forward snapshot
     * commits from the export workflow. Block deletion and force pushes; no pull request
     * or status check rules, because nothing merges there.
     */
    const publicRuleset = yield* GitHub.Ruleset("PublicExport", {
      owner,
      repository: publicName,
      name: `export-${publicBranch}`,
      enforcement: "active",
      target: "branch",
      conditions: { include: [`refs/heads/${publicBranch}`] },
      rules: { deletion: true, nonFastForward: true },
    }).pipe(retain());

    return {
      repository: `${owner}/${name}`,
      publicRepository: `${owner}/${publicName}`,
      publicBranch,
      publicRulesetId: publicRuleset.rulesetId,
      repositoryId: repository.repoId,
      environments: [production],
      deployTokenId: deployToken.tokenId,
      rulesetId: ruleset?.rulesetId,
      rulesetEnforcement: enforcement,
      requiredStatusChecks,
    };
  }),
);
