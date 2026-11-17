/**
 * Removes a deployed E2E run's PlanetScale branch when the stage's Alchemy destroy left it.
 *
 * Alchemy's destroy deletes the branch only when its state records it as the stage's own. If the
 * deploy stopped after PlanetScale created the branch but before Alchemy recorded it (a create
 * that never became ready, a killed process), destroy logs that the branch "exists in the cloud but
 * is not owned by this stack" and leaves it, billing, while the run looks finished.
 *
 * What this may delete, and nothing else:
 * - one branch, named exactly `test-<slug>` for the stage being destroyed, where the slug is a
 *   deployed E2E run's (`e2e-` and 1-13 lowercase letters or digits, `e2e/sdk/deployment.ts`). The
 *   name is derived from the slug; it is never taken from a branch list or matched by a pattern;
 * - on the test database the job names (`TEST_STAGE_DATABASE`), with the job's own PlanetScale
 *   token, the one the stage's deploy and destroy use;
 * - only a development branch: the branch is read first, and a production branch (one created at a
 *   paid size) is never sent a delete. The stage token cannot delete those anyway; they need someone
 *   with an organization admin token.
 *
 * It first waits up to 30 s for the destroy's own delete to land, and sends a delete only if the
 * branch is still there; after a delete it waits up to 2 minutes for PlanetScale to answer 404.
 * Each call has a 20 s time-out. Every outcome says whether a delete was sent and what PlanetScale
 * answered (`branchOutcomeMessage`).
 */
import { Config, Duration, Effect, Option, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { planetScaleApi } from "./test-stage-orphans.ts";

/** A deployed E2E run's slug (`e2e/sdk/deployment.ts`). */
const e2eSlug = /^e2e-[a-z0-9]{1,13}$/u;

/**
 * The only branch a stage's teardown may delete by name: `test-<slug>` for a deployed E2E run's
 * slug. Anything else is refused with the reason, before any request is made.
 */
export const stageBranchFor = (
  slug: string,
): { readonly branch: string } | { readonly refused: string } =>
  e2eSlug.test(slug)
    ? { branch: `test-${slug}` }
    : { refused: `"${slug}" is not a deployed E2E run's slug (e2e- and 1-13 letters or digits)` };

/** Whether `name` is exactly the branch `stageBranchFor(slug)` derives. */
export const isStageBranch = (name: string, slug: string) => {
  const derived = stageBranchFor(slug);
  return "branch" in derived && derived.branch === name;
};

export type BranchOutcome =
  /** The name was refused; nothing was sent. */
  | { readonly _tag: "Refused"; readonly reason: string }
  /** PlanetScale answered 404 before any delete was sent: nothing to remove. */
  | { readonly _tag: "Absent" }
  /** A production branch; no delete was sent. */
  | { readonly _tag: "Production" }
  /** The branch could not be read (an answer other than 200 or 404, or none in time); no delete was sent. */
  | { readonly _tag: "Unreadable"; readonly status: number | undefined }
  /** A delete was sent and no answer came back in time. */
  | { readonly _tag: "DeleteUnanswered" }
  /** A delete was sent and PlanetScale refused it. */
  | { readonly _tag: "DeleteRefused"; readonly status: number }
  /** A delete was sent and accepted, and PlanetScale then answered 404. */
  | { readonly _tag: "Deleted"; readonly status: number }
  /** A delete was sent and accepted, but PlanetScale still answered 200 at the end of the wait. */
  | { readonly _tag: "StillThere"; readonly status: number; readonly waited: string };

/** Whether the outcome leaves no branch, so the stage's lease may go. */
export const branchGone = (outcome: BranchOutcome) =>
  outcome._tag === "Absent" || outcome._tag === "Deleted";

/** One line for the log and the failure: the branch, whether a delete was sent, the answer, who can act. */
export const branchOutcomeMessage = (branch: string, outcome: BranchOutcome) => {
  const remover =
    "Its stage lease is kept, so scheduled cleanup tries again; if it stays, someone with permission must delete it in PlanetScale";
  switch (outcome._tag) {
    case "Refused":
      return `Not deleting PlanetScale branch ${branch}: ${outcome.reason}. No request was sent.`;
    case "Absent":
      return `PlanetScale branch ${branch} is gone (PlanetScale answers 404). No delete was needed.`;
    case "Deleted":
      return `PlanetScale branch ${branch} was left by the destroy; a delete was sent (PlanetScale answered ${outcome.status}) and it is gone (404).`;
    case "Production":
      return `PlanetScale branch ${branch} is a production branch (created at a paid size). No delete was sent: the stage token cannot delete production branches. ${remover}, with an organization admin token.`;
    case "Unreadable":
      return `PlanetScale branch ${branch} could not be read (${outcome.status === undefined ? `no answer within ${callTimeout}` : `PlanetScale answered ${outcome.status}`}). No delete was sent. ${remover}.`;
    case "DeleteUnanswered":
      return `PlanetScale branch ${branch} was left by the destroy. A delete was sent; no answer came back within ${callTimeout}. ${remover}.`;
    case "DeleteRefused":
      return `PlanetScale branch ${branch} was left by the destroy. A delete was sent and PlanetScale refused it (${outcome.status}). ${remover}.`;
    case "StillThere":
      return `PlanetScale branch ${branch} was left by the destroy. A delete was sent and accepted (${outcome.status}), but PlanetScale still lists it after ${outcome.waited}. ${remover}.`;
  }
};

const Branch = Schema.Struct({ name: Schema.String, production: Schema.Boolean });

/** Each call to PlanetScale gets at most this long; one that runs out counts as no answer. */
const callTimeout = "20 seconds";
/**
 * How often the branch is read while waiting. Before any delete, it is read for up to 6 polls
 * (30 s by default): the deploy tool's own delete of a branch it recorded returns before
 * PlanetScale answers 404 (it took 0.4-6.1 s in the deployed runs' logs), and a branch that goes in
 * that time needs no second delete. After a delete, up to 24 polls (2 minutes by default).
 */
const pollInterval = Config.Duration("TEST_STAGE_BRANCH_POLL").pipe(
  Config.withDefault(Duration.seconds(5)),
);
const settlePolls = 6;
const confirmPolls = 24;

/**
 * Remove the stage's branch if it is still there once the destroy's own delete has had time to
 * land. `Option.none()` when the job names no PlanetScale test database.
 */
export const removeStageBranch = (slug: string) =>
  Effect.gen(function* () {
    const derived = stageBranchFor(slug);
    if ("refused" in derived)
      return Option.some<BranchOutcome>({ _tag: "Refused", reason: derived.refused });
    const database = yield* Config.option(Config.NonEmptyString("TEST_STAGE_DATABASE"));
    if (Option.isNone(database)) return Option.none<BranchOutcome>();
    const organization = yield* Config.NonEmptyString("PLANETSCALE_ORGANIZATION");
    const id = yield* Config.Redacted("PLANETSCALE_API_TOKEN_ID");
    const token = yield* Config.Redacted("PLANETSCALE_API_TOKEN");
    const poll = yield* pollInterval;
    const api = yield* planetScaleApi;
    const http = yield* HttpClient.HttpClient;
    const url = `${api}/v1/organizations/${encodeURIComponent(organization)}/databases/${encodeURIComponent(database.value)}/branches/${encodeURIComponent(derived.branch)}`;
    /** One call: its answer, or none when it failed or ran out of time. */
    const call = (request: HttpClientRequest.HttpClientRequest) =>
      http
        .execute(
          request.pipe(
            HttpClientRequest.setHeader(
              "authorization",
              `${Redacted.value(id)}:${Redacted.value(token)}`,
            ),
          ),
        )
        .pipe(Effect.timeout(callTimeout), Effect.option);
    const read = call(HttpClientRequest.get(url));
    /** Read until PlanetScale answers 404, at most `polls` more times; whether it did. */
    const gone = (polls: number) =>
      read.pipe(
        Effect.filterOrFail((answer) => Option.isSome(answer) && answer.value.status === 404),
        Effect.retry({ schedule: Schedule.spaced(poll), times: polls }),
        Effect.isSuccess,
      );

    const before = yield* read;
    if (Option.isNone(before))
      return Option.some<BranchOutcome>({ _tag: "Unreadable", status: undefined });
    if (before.value.status === 404) return Option.some<BranchOutcome>({ _tag: "Absent" });
    // Only a 200 can describe the branch; a body that merely looks like one under another status
    // (an error page, a proxy's answer) is not trusted.
    if (before.value.status !== 200)
      return Option.some<BranchOutcome>({ _tag: "Unreadable", status: before.value.status });
    const found = yield* before.value.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Branch)),
      Effect.timeout(callTimeout),
      Effect.option,
    );
    // The answer must be the branch asked for; anything else is not deleted.
    if (Option.isNone(found) || found.value.name !== derived.branch)
      return Option.some<BranchOutcome>({ _tag: "Unreadable", status: 200 });
    if (found.value.production) return Option.some<BranchOutcome>({ _tag: "Production" });
    // The destroy's own delete may still be landing: give it time before sending one.
    if (yield* gone(settlePolls)) return Option.some<BranchOutcome>({ _tag: "Absent" });

    const deleted = yield* call(HttpClientRequest.delete(url));
    if (Option.isNone(deleted)) return Option.some<BranchOutcome>({ _tag: "DeleteUnanswered" });
    const status = deleted.value.status;
    if (status < 200 || status >= 300)
      return Option.some<BranchOutcome>({ _tag: "DeleteRefused", status });
    return Option.some<BranchOutcome>(
      (yield* gone(confirmPolls))
        ? { _tag: "Deleted", status }
        : {
            _tag: "StillThere",
            status,
            waited: Duration.format(Duration.times(poll, confirmPolls)),
          },
    );
  });
