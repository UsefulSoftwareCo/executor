/** Explicit feedback filed as issues in an operator-owned GitHub repository. */
import { FeedbackUnavailable } from "@executor-js/telemetry/product-analytics";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

/** What an issue says about one submission; the operator's repository sees the sender. */
export interface FeedbackReport {
  readonly message: string;
  readonly submittedAt: string;
  readonly who: string;
  readonly source: string | undefined;
  readonly organizationId: string;
  readonly instanceOrigin: string;
}

const Created = Schema.Struct({ html_url: Schema.String, number: Schema.Int });
/** The issue GitHub created for a submission. */
export interface FeedbackIssue {
  readonly url: string;
  readonly number: number;
}

const Repository = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[\w.-]+$/u;
const titleLimit = 120;

/** The first line that says something, without Markdown heading or list markers. */
const issueTitle = (message: string) => {
  const line =
    message
      .split("\n")
      .map((text) => text.replace(/^[\s#>*-]+/u, "").trim())
      .find((text) => text !== "") ?? "Executor feedback";
  return line.length > titleLimit ? `${line.slice(0, titleLimit - 1)}…` : line;
};

const issueBody = (report: FeedbackReport) =>
  [
    report.message,
    "",
    "---",
    "",
    "Submitted through Executor feedback.",
    "",
    `- From: ${report.who}`,
    ...(report.source === undefined ? [] : [`- Source: ${report.source}`]),
    `- Organization: ${report.organizationId}`,
    `- Instance: ${report.instanceOrigin}`,
    `- Submitted: ${report.submittedAt}`,
  ].join("\n");

const optionalText = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Effect.map(Option.map((text) => text.trim())),
    Effect.map(Option.filter((text) => text !== "")),
  );

/**
 * A repository leaves issue filing off when unset. The returned effect needs an HTTP client and
 * fails for any refusal; the caller bounds, reports and hides it.
 */
export const selfHostFeedbackIssues = Effect.gen(function* () {
  const repository = yield* optionalText("EXECUTOR_FEEDBACK_GITHUB_REPOSITORY");
  if (Option.isNone(repository)) return undefined;
  const token = yield* Config.Redacted("EXECUTOR_FEEDBACK_GITHUB_TOKEN").pipe(Config.option);
  const api = URL.parse(
    Option.getOrElse(
      yield* optionalText("EXECUTOR_FEEDBACK_GITHUB_API_URL"),
      () => "https://api.github.com",
    ),
  );
  const labels = Option.getOrElse(yield* optionalText("EXECUTOR_FEEDBACK_GITHUB_LABELS"), () => "")
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");
  if (
    !Repository.test(repository.value) ||
    Option.isNone(token) ||
    Redacted.value(token.value).trim() === "" ||
    api === null ||
    !["https:", "http:"].includes(api.protocol) ||
    api.username !== "" ||
    api.password !== "" ||
    api.search !== "" ||
    api.hash !== ""
  ) {
    yield* Effect.logWarning(
      "EXECUTOR_FEEDBACK_GITHUB_REPOSITORY must be owner/repository with EXECUTOR_FEEDBACK_GITHUB_TOKEN set; EXECUTOR_FEEDBACK_GITHUB_API_URL must be an HTTP(S) URL without credentials or a query",
    );
    return () => Effect.fail(new FeedbackUnavailable());
  }
  const destination = `${api.href.replace(/\/+$/u, "")}/repos/${repository.value}/issues`;

  return (report: FeedbackReport) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(
        HttpClientRequest.post(destination).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            title: issueTitle(report.message),
            body: issueBody(report),
            ...(labels.length === 0 ? {} : { labels }),
          }),
          HttpClientRequest.setHeaders({
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "executor-feedback",
          }),
          HttpClientRequest.bearerToken(token.value),
        ),
      );
      if (response.status < 200 || response.status >= 300) return yield* new FeedbackUnavailable();
      const created = yield* Schema.decodeUnknownEffect(Created)(yield* response.json);
      return { url: created.html_url, number: created.number } satisfies FeedbackIssue;
    });
});
