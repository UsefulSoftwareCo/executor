import { Config, Duration, Effect, Option, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { planetScaleApi } from "./test-stage-orphans.ts";
import { TestStageSlug } from "../contracts/test-stage-lifetime.ts";

const e2eSlug = /^e2e-[a-z0-9]{1,13}$/u;

export const stageBranchFor = (
  slug: string,
): { readonly branch: string } | { readonly refused: string } =>
  e2eSlug.test(slug)
    ? { branch: `test-${slug}` }
    : { refused: `"${slug}" is not a deployed E2E run's slug (e2e- and 1-13 letters or digits)` };

const stageBranchToRead = (
  slug: string,
): { readonly branch: string; readonly mayDelete: boolean } | { readonly refused: string } =>
  Schema.is(TestStageSlug)(slug)
    ? { branch: `test-${slug}`, mayDelete: e2eSlug.test(slug) }
    : { refused: `"${slug}" is not a test stage's slug` };

export const isStageBranch = (name: string, slug: string) => {
  const derived = stageBranchFor(slug);
  return "branch" in derived && derived.branch === name;
};

export type BranchOutcome =
  | { readonly _tag: "Refused"; readonly reason: string }
  | { readonly _tag: "Absent" }
  | { readonly _tag: "NotDeleted"; readonly reason: string }
  | { readonly _tag: "Production" }
  | { readonly _tag: "Unreadable"; readonly status: number | undefined }
  | { readonly _tag: "DeleteUnanswered" }
  | { readonly _tag: "DeleteRefused"; readonly status: number }
  | { readonly _tag: "Deleted"; readonly status: number }
  | { readonly _tag: "StillThere"; readonly status: number; readonly waited: string };

export const branchGone = (outcome: BranchOutcome) =>
  outcome._tag === "Absent" || outcome._tag === "Deleted";

export const branchOutcomeMessage = (branch: string, outcome: BranchOutcome) => {
  const remover =
    "Its stage lease is kept, so scheduled cleanup tries again; if it stays, someone with permission must delete it in PlanetScale";
  switch (outcome._tag) {
    case "Refused":
      return `Not deleting PlanetScale branch ${branch}: ${outcome.reason}. No request was sent.`;
    case "NotDeleted":
      return `PlanetScale branch ${branch} is still there after the destroy. ${outcome.reason}, so no delete was sent. ${remover}.`;
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

const callTimeout = "20 seconds";
const pollInterval = Config.Duration("TEST_STAGE_BRANCH_POLL").pipe(
  Config.withDefault(Duration.seconds(5)),
);
const settlePolls = 6;
const confirmPolls = 24;

export const removeStageBranch = (slug: string) =>
  Effect.gen(function* () {
    const derived = stageBranchToRead(slug);
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
    if (before.value.status !== 200)
      return Option.some<BranchOutcome>({ _tag: "Unreadable", status: before.value.status });
    const found = yield* before.value.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Branch)),
      Effect.timeout(callTimeout),
      Effect.option,
    );
    if (Option.isNone(found) || found.value.name !== derived.branch)
      return Option.some<BranchOutcome>({ _tag: "Unreadable", status: 200 });
    if (found.value.production) return Option.some<BranchOutcome>({ _tag: "Production" });
    if (yield* gone(settlePolls)) return Option.some<BranchOutcome>({ _tag: "Absent" });
    if (!derived.mayDelete)
      return Option.some<BranchOutcome>({
        _tag: "NotDeleted",
        reason: `Only a deployed E2E run's branch is deleted by name (e2e- and 1-13 letters or digits)`,
      });

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
