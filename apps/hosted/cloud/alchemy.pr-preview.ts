/** Comments outlive the deployed stage, so reopening a PR updates the same comment. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Layer, Schema } from "effect";
import { PreviewCommit, PreviewNumber, previewRepository } from "./src/contracts/pr-preview.ts";
import {
  previewCommentMarker,
  previewOrigin,
  previewSlug,
  previewStatusLine,
} from "./src/contracts/pr-preview-selection.ts";

export default Alchemy.Stack(
  "executor-pr-preview-comments",
  {
    providers: Layer.mergeAll(GitHub.providers(), Cloudflare.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const number = yield* Config.Number("PREVIEW_NUMBER").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PreviewNumber)),
    );
    if ((yield* Stage) !== previewSlug(number))
      return yield* Effect.die(new Error("The comment stage must match its PR number."));
    const repository = yield* previewRepository;
    const parts = repository.split("/");
    const owner = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(parts[0]);
    const name = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(parts[1]);
    const sha = yield* Config.String("PREVIEW_SHA").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PreviewCommit)),
    );
    const status = yield* Config.Literals(
      ["deploying", "ready", "failed", "closed", "stacked", "unneeded", "cleanup-failed"],
      "PREVIEW_STATUS",
    );
    const descriptions = {
      deploying:
        "Deploying. The URL may still serve the previous commit until verification finishes.",
      ready: "Ready. Health, login assets and sign-in redirects verified.",
      failed: "Deployment or verification failed. The URL may still serve an earlier commit.",
      closed: "Removed because this PR is closed. Reopening the PR creates a fresh environment.",
      stacked:
        "Removed because another open PR builds on this branch. The top of the stack has the preview.",
      unneeded:
        "Removed because this PR changes nothing a Cloud preview runs, such as tests, CI, notes, tooling or the self-host and local products. A push that changes Cloud deploys it again.",
      "cleanup-failed":
        "Cleanup failed. Scheduled reconciliation will retry; resources may still exist.",
    };
    const run = yield* Config.String("GITHUB_RUN_ID").pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[0-9]+$/u))),
      ),
    );
    const comment = yield* GitHub.Comment("Preview", {
      owner,
      repository: name,
      issueNumber: number,
      body: [
        // The workflow reads the status back to tell whether a stage may remain to remove.
        `${previewCommentMarker}\n${previewStatusLine(status)}`,
        "### Executor preview",
        descriptions[status],
        ...(status === "closed" || status === "stacked" || status === "unneeded"
          ? []
          : [`[Open preview](${previewOrigin(number)})`]),
        `Commit: [${sha.slice(0, 7)}](https://github.com/${repository}/commit/${sha}) · [Workflow run](https://github.com/${repository}/actions/runs/${run})`,
        "Sent from my Codex",
      ].join("\n\n"),
    });
    return { comment: comment.htmlUrl };
  }).pipe(Effect.orDie),
);
