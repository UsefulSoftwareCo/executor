import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import { retain } from "alchemy/RemovalPolicy";
import { Config, Effect, Layer, Option, Redacted } from "effect";
import { stackState } from "./src/infrastructure/state.ts";
import { productionSocialCallbackOrigin } from "./src/infrastructure/deploy-settings.ts";
import { BrowserOrigin, browserOriginSetting } from "./src/infrastructure/stage.ts";
import {
  type ExecutorShOwner,
  executorShSetting,
} from "./src/infrastructure/executor-sh-setting.ts";
import { missingV1WorkosKey } from "./src/infrastructure/v1-api-key-settings.ts";
import {
  v1McpForwardSecretName,
  v1SessionHandoffSecretName,
} from "./src/infrastructure/secrets.ts";
import {
  firstPartyGitHubSettings,
  firstPartyGoogleSettings,
  firstPartySlackSettings,
  missingFirstPartyGitHubClient,
  partialFirstPartyGoogleClient,
  partialFirstPartySlackClient,
} from "./src/infrastructure/first-party-oauth-settings.ts";

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

const nonEmptySecret = (name: string) =>
  Config.Redacted(name).pipe(
    Config.option,
    Effect.map(Option.filter((value) => Redacted.value(value) !== "")),
  );

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

export default Alchemy.Stack(
  "executor-next-ci",
  {
    providers: Layer.mergeAll(GitHub.providers(), Cloudflare.providers()),
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
      allowSquashMerge: true,
      allowMergeCommit: false,
      allowRebaseMerge: false,
      allowAutoMerge: false,
      deleteBranchOnMerge: true,
    }).pipe(retain());

    const target = { owner, repository: name };

    const production = "production";

    const deployToken = yield* Cloudflare.ApiToken.AccountApiToken("DeployToken", {
      name: `executor-next-ci-${name}`,
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Workers Observability Write",
            "Workers R2 Storage Write",
            "Hyperdrive Write",
            "Account Settings Read",
            "Secrets Store Write",
            "Account: SSL and Certificates Write",
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
        {
          effect: "allow",
          permissionGroups: ["SSL and Certificates Write", "Workers Routes Write"],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: {
              "com.cloudflare.api.account.zone.*": "*",
            },
          },
        },
      ],
    }).pipe(retain());

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

    yield* GitHub.Variable("CiRunnerMode", {
      ...target,
      name: "CI_RUNNER_MODE",
      value: runnerMode,
    }).pipe(retain());

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

    yield* GitHub.Variable("production-OAUTH_PROXY_PRODUCTION_URL", {
      ...target,
      name: "OAUTH_PROXY_PRODUCTION_URL",
      value: productionSocialCallbackOrigin,
      environment: production,
    }).pipe(retain());

    const browserOrigin: BrowserOrigin = yield* browserOriginSetting;
    yield* GitHub.Variable("production-CLOUD_BROWSER_ORIGIN", {
      ...target,
      name: "CLOUD_BROWSER_ORIGIN",
      value: browserOrigin,
      environment: production,
    }).pipe(retain());

    const executorSh: ExecutorShOwner = yield* executorShSetting;
    yield* GitHub.Variable("production-CLOUD_EXECUTOR_SH", {
      ...target,
      name: "CLOUD_EXECUTOR_SH",
      value: executorSh,
      environment: production,
    }).pipe(retain());

    const v1Key = yield* Config.Redacted("V1_WORKOS_API_KEY").pipe(
      Config.option,
      Effect.map(Option.filter((value) => Redacted.value(value) !== "")),
    );
    if (Option.isNone(v1Key)) return yield* Effect.die(new Error(missingV1WorkosKey));
    yield* GitHub.Secret("production-V1_WORKOS_API_KEY", {
      ...target,
      name: "V1_WORKOS_API_KEY",
      value: v1Key.value,
      environment: production,
    }).pipe(retain());

    const credentials = (names: { readonly clientId: string; readonly clientSecret: string }) =>
      Effect.all([nonEmptySecret(names.clientId), nonEmptySecret(names.clientSecret)]);
    const [githubId, githubSecret] = yield* credentials(firstPartyGitHubSettings);
    if (Option.isNone(githubId) || Option.isNone(githubSecret))
      return yield* Effect.die(new Error(missingFirstPartyGitHubClient));
    const [googleId, googleSecret] = yield* credentials(firstPartyGoogleSettings);
    if (Option.isSome(googleId) !== Option.isSome(googleSecret))
      return yield* Effect.die(new Error(partialFirstPartyGoogleClient));
    const [slackId, slackSecret] = yield* credentials(firstPartySlackSettings);
    if (Option.isSome(slackId) !== Option.isSome(slackSecret))
      return yield* Effect.die(new Error(partialFirstPartySlackClient));
    const firstPartySecrets = [
      [firstPartyGitHubSettings.clientId, githubId.value],
      [firstPartyGitHubSettings.clientSecret, githubSecret.value],
      ...(Option.isSome(googleId) && Option.isSome(googleSecret)
        ? ([
            [firstPartyGoogleSettings.clientId, googleId.value],
            [firstPartyGoogleSettings.clientSecret, googleSecret.value],
          ] as const)
        : []),
      ...(Option.isSome(slackId) && Option.isSome(slackSecret)
        ? ([
            [firstPartySlackSettings.clientId, slackId.value],
            [firstPartySlackSettings.clientSecret, slackSecret.value],
          ] as const)
        : []),
    ] as const;
    yield* Effect.forEach(firstPartySecrets, ([secret, value]) =>
      GitHub.Secret(`production-${secret}`, {
        ...target,
        name: secret,
        value,
        environment: production,
      }).pipe(retain()),
    );

    const v1Forward = yield* nonEmptySecret(v1McpForwardSecretName);
    if (Option.isSome(v1Forward))
      yield* GitHub.Secret(`production-${v1McpForwardSecretName}`, {
        ...target,
        name: v1McpForwardSecretName,
        value: v1Forward.value,
        environment: production,
      }).pipe(retain());

    const v1Handoff = yield* nonEmptySecret(v1SessionHandoffSecretName);
    if (Option.isSome(v1Handoff))
      yield* GitHub.Secret(`production-${v1SessionHandoffSecretName}`, {
        ...target,
        name: v1SessionHandoffSecretName,
        value: v1Handoff.value,
        environment: production,
      }).pipe(retain());

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
    };
  }),
);
