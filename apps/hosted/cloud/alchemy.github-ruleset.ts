/**
 * The `main` branch ruleset. It is its own stack so that it can change without applying the CI
 * stack, which writes every production secret and variable from `.env.ci.op` (see notes/ci.md).
 */
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

/**
 * The contexts `ci.yml` reports when it calls `checks.yml`. The E2E jobs run as matrix runners
 * whose names change with the selection, so `checks / e2e` stands for all of them. Renaming
 * either job must update this list.
 */
const requiredStatusChecks = ["checks / check", "checks / e2e"] as const;

/** The GitHub Actions app, which reports the checks. */
const gitHubActionsAppId = 15368;

/**
 * The environment that holds the beta version bump's push key. It exists before the first apply,
 * with a deployment branch policy of `main` only, so no workflow on another ref can read the key.
 */
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
    // `evaluate` logs rule results without blocking; `disabled` turns the ruleset off.
    const enforcement = yield* Config.Literals(
      ["evaluate", "active", "disabled"],
      "CI_RULESET_ENFORCEMENT",
    ).pipe(Config.withDefault("active" as const));

    /**
     * The beta workflow pushes its version bump straight to `main` over SSH with this key. The
     * key pair is minted here and lives only in this stack's encrypted state and the `beta`
     * environment's secret: no person or vault holds it. A deploy key can push git but cannot
     * call the API, so it cannot merge a pull request past the checks. Replacing the KeyPair
     * rotates the key: the next apply adds the new public key and secret and removes the old key.
     */
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

    /**
     * Every change reaches `main` through a pull request whose required checks passed. No person
     * or role may bypass: agents merge with an admin's token, and GitHub lets a bypass actor's API
     * merge through without asking, so an admin bypass would gate nothing for them. The one
     * exception is the repository's deploy keys, so `beta.yml` can push its version bump. GitHub
     * cannot name one deploy key: the bypass covers every deploy key on the repository, and this
     * stack's is the only one. The GitHub Actions app cannot be a bypass actor: GitHub refuses an
     * app that is not installed on the repository, and it is not. The checks are pinned to that
     * app, so nothing else can report them. The emergency override is an admin setting
     * enforcement to `disabled`.
     */
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
