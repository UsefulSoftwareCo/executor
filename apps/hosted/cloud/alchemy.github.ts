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
import { Config, Effect, Layer, Option } from "effect";
import { stackState } from "./src/infrastructure/state.ts";

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
  "CLOUD_DATABASE_CONNECTION_LIMIT",
  "CLOUD_PLACEMENT_REGION",
  "EXECUTOR_APP_UI_BASE_URL",
  "OAUTH_PROXY_PRODUCTION_URL",
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
 * Publish credentials. `NPM_TOKEN` is deliberately absent: npm trusted publishing gives the
 * release workflow a short-lived OIDC credential and provenance, and needs no stored token.
 * See notes/ci.md for the one-line change if a scoped token is chosen instead.
 */
const releaseSecrets = [
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "CSC_KEY_PASSWORD",
  "CSC_LINK",
  "RELEASE_PAT",
] as const;

/**
 * Required status checks on `main`. These are the contexts reported by `ci.yml` calling
 * `checks.yml` (PR #246). `CI_RULESET_ENFORCEMENT` defaults to `active`, so an apply that
 * cannot create the ruleset fails loudly rather than leaving `main` silently unprotected.
 * Rulesets need GitHub Pro on a private repository, which is the blocker today; `.env.ci.op`
 * sets `disabled` until the plan allows them. `evaluate` is log only and blocks nothing.
 */
const requiredStatusChecks = [
  "checks / check",
  "checks / e2e-local",
  "checks / e2e-self-host",
  "checks / e2e-cloud",
] as const;

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
    const release = "release";

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
            "Hyperdrive Write",
            "Account Settings Read",
            // The shared state store keeps its bearer token in the account Secrets Store.
            "Secrets Store Write",
            // Hyperdrive's PlanetScale CA certificate is an account-level certificate upload.
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

    // Distribution is deferred, so a missing release secret is skipped rather than fatal. The
    // release environment exists from the first apply; its secrets arrive when publishing resumes.
    yield* Effect.forEach(releaseSecrets, (secret) =>
      Config.Redacted(secret).pipe(
        Config.option,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.logWarning(`release secret ${secret} is not configured; skipped`),
            onSome: (value) =>
              GitHub.Secret(`release-${secret}`, {
                ...target,
                name: secret,
                value,
                environment: release,
              }).pipe(retain()),
          }),
        ),
      ),
    );

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
      environments: [production, release],
      deployTokenId: deployToken.tokenId,
      rulesetId: ruleset?.rulesetId,
      rulesetEnforcement: enforcement,
      requiredStatusChecks,
    };
  }),
);
