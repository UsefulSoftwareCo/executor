import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import { KeyPair, KeyPairProvider } from "alchemy/KeyPair";
import { retain } from "alchemy/RemovalPolicy";
import { Config, Effect, Layer } from "effect";
import {
  GitHubDeployKey,
  gitHubDeployKeyProvider,
} from "./src/infrastructure/github-deploy-key.ts";
import { stackState } from "./src/infrastructure/state.ts";

const requiredStatusChecks = ["checks / check", "checks / e2e"] as const;

const gitHubActionsAppId = 15368;

const betaPushEnvironment = "beta";

const github = GitHub.providers();

export default Alchemy.Stack(
  "executor-next-github-ruleset",
  {
    providers: Layer.mergeAll(
      github,
      gitHubDeployKeyProvider().pipe(Layer.provide(github)),
      KeyPairProvider(),
      Cloudflare.providers(),
    ),
    state: stackState,
  },
  Effect.gen(function* () {
    const owner = yield* Config.NonEmptyString("GITHUB_OWNER");
    const repository = yield* Config.NonEmptyString("GITHUB_REPOSITORY_NAME");
    const enforcement = yield* Config.Literals(
      ["evaluate", "active", "disabled"],
      "CI_RULESET_ENFORCEMENT",
    ).pipe(Config.withDefault("active" as const));

    const pushKey = yield* KeyPair("BetaPushKey", { algorithm: "ec" });
    const deployKey = yield* GitHubDeployKey("BetaPushDeployKey", {
      owner,
      repository,
      title: "Beta version bump (executor-next-github-ruleset stack)",
      publicKey: pushKey.publicKey,
      readOnly: false,
    });
    yield* GitHub.Secret("BetaPushKeySecret", {
      owner,
      repository,
      environment: betaPushEnvironment,
      name: "BETA_PUSH_KEY",
      value: pushKey.privateKey,
    });

    const ruleset = yield* GitHub.Ruleset("Main", {
      owner,
      repository,
      name: "main",
      enforcement,
      target: "branch",
      conditions: { include: ["refs/heads/main"] },
      bypassActors: [{ actorType: "DeployKey", bypassMode: "always" }],
      rules: {
        deletion: true,
        nonFastForward: true,
        requiredStatusChecks: {
          checks: requiredStatusChecks.map((context) => ({
            context,
            integrationId: gitHubActionsAppId,
          })),
          strictRequiredStatusChecksPolicy: false,
        },
        pullRequest: { requiredApprovingReviewCount: 0 },
      },
    }).pipe(retain());

    return {
      repository: `${owner}/${repository}`,
      rulesetId: ruleset.rulesetId,
      enforcement,
      requiredStatusChecks,
      betaPushDeployKeyId: deployKey.keyId,
    };
  }),
);
