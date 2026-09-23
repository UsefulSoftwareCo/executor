/** Shared empty Neon parent and preview automation configuration, managed separately from each preview. */
import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as GitHub from "alchemy/GitHub";
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Layer } from "effect";

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
    ] as const)
      yield* GitHub.Variable(name, {
        ...target,
        name,
        value: yield* Config.NonEmptyString(name),
      }).pipe(retain());
    for (const name of [
      "TEST_STAGE_DATABASE_ADMIN_URL",
      "CLOUDFLARE_API_TOKEN",
      "PLANETSCALE_API_TOKEN",
      "PLANETSCALE_API_TOKEN_ID",
      "AXIOM_TOKEN",
    ] as const)
      yield* GitHub.Secret(name, { ...target, name, value: yield* Config.Redacted(name) }).pipe(
        retain(),
      );
    return { projectId: project.projectId };
  }),
);
