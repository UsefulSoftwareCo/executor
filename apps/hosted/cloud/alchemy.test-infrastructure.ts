/** Shared empty Neon parent and preview automation configuration, managed separately from each preview. */
import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as GitHub from "alchemy/GitHub";
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Layer } from "effect";
import { productionSocialCallbackOrigin } from "./src/infrastructure/deploy-settings.ts";

export default Alchemy.Stack(
  "executor-test-infrastructure",
  {
    providers: Layer.mergeAll(Neon.providers(), GitHub.providers(), Cloudflare.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    if ((yield* Stage) !== "test-infrastructure")
      return yield* Effect.die(new Error("Use the shared test-infrastructure stage."));
    const project = yield* Neon.Project("PreviewProject", {
      name: "executor-previews",
      region: "aws-us-east-1",
      pgVersion: 17,
      orgId: yield* Config.NonEmptyString("NEON_ORGANIZATION_ID"),
      defaultBranchName: "main",
      databaseName: "neondb",
      historyRetentionSeconds: 21600,
    }).pipe(retain());
    const target = {
      owner: yield* Config.NonEmptyString("GITHUB_OWNER"),
      repository: yield* Config.NonEmptyString("GITHUB_REPOSITORY_NAME"),
      environment: "staging",
    };
    yield* GitHub.Secret("NeonApiKey", {
      ...target,
      name: "NEON_API_KEY",
      value: yield* Config.Redacted("NEON_API_KEY"),
    }).pipe(retain());
    yield* GitHub.Variable("NeonProjectId", {
      ...target,
      name: "TEST_STAGE_NEON_PROJECT_ID",
      value: project.projectId,
    }).pipe(retain());
    for (const name of [
      "TEST_STAGE_DATABASE",
      "CLOUDFLARE_ACCOUNT_ID",
      "PLANETSCALE_ORGANIZATION",
      "AXIOM_ORG_ID",
      "EXECUTOR_APP_DOMAIN_ZONE",
      "CLOUD_PLACEMENT_REGION",
      "AUTH_EMAIL_DOMAIN",
    ] as const)
      yield* GitHub.Variable(name, {
        ...target,
        name,
        value: yield* Config.NonEmptyString(name),
      }).pipe(retain());
    // Test stages sign in through production's proxy, at the edge where its social sign-ins return.
    yield* GitHub.Variable("OAUTH_PROXY_PRODUCTION_URL", {
      ...target,
      name: "OAUTH_PROXY_PRODUCTION_URL",
      value: productionSocialCallbackOrigin,
    }).pipe(retain());
    for (const name of [
      "TEST_STAGE_DATABASE_ADMIN_URL",
      "CLOUDFLARE_API_TOKEN",
      "PLANETSCALE_API_TOKEN",
      "PLANETSCALE_API_TOKEN_ID",
      "AXIOM_TOKEN",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "OAUTH_PROXY_SECRET",
      "CONTEXT_DEV_API_KEY",
    ] as const)
      yield* GitHub.Secret(name, { ...target, name, value: yield* Config.Redacted(name) }).pipe(
        retain(),
      );
    // GitHub reserves the GITHUB_ prefix in Actions secrets. Login clients are shared with
    // the existing OAuth proxy; previews still own their signing and encryption secrets.
    for (const name of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const)
      yield* GitHub.Secret(`Auth${name}`, {
        ...target,
        name: `AUTH_${name}`,
        value: yield* Config.Redacted(name),
      }).pipe(retain());
    return { projectId: project.projectId };
  }),
);
