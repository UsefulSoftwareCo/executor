/** Explicit feedback delivery to operator-owned receivers, independent of usage analytics. */
import { CurrentUsage, ProductAnalytics } from "@executor-js/hosted-server";
import { FeedbackUnavailable } from "@executor-js/telemetry/product-analytics";
import { Config, DateTime, Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import { type FeedbackIssue, selfHostFeedbackIssues } from "./feedback-github.ts";

const Person = Schema.Struct({ email: Schema.String });

/** One receiver's request: bounded, never traced, and reported without its URL or response. */
const delivered = <A, E>(receiver: string, request: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  request.pipe(
    Effect.timeout("10 seconds"),
    Effect.tapError(() => Effect.logWarning(`Feedback ${receiver} delivery failed`)),
    // Do not trace the URL, authorization or response: all may contain receiver secrets.
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provide(FetchHttpClient.layer),
    Effect.option,
  );

/** The operator's HTTP receiver; an unset URL leaves it off. */
const webhookReceiver = Effect.gen(function* () {
  const configured = yield* Config.Redacted("EXECUTOR_FEEDBACK_WEBHOOK_URL").pipe(Config.option);
  if (Option.isNone(configured) || Redacted.value(configured.value).trim() === "") return undefined;
  const destination = URL.parse(Redacted.value(configured.value));
  if (
    destination === null ||
    !["https:", "http:"].includes(destination.protocol) ||
    destination.username !== "" ||
    destination.password !== ""
  ) {
    yield* Effect.logWarning(
      "EXECUTOR_FEEDBACK_WEBHOOK_URL must be an HTTP(S) URL without embedded credentials",
    );
    return () => Effect.fail(new FeedbackUnavailable());
  }
  const secret = yield* Config.Redacted("EXECUTOR_FEEDBACK_WEBHOOK_SECRET").pipe(Config.option);
  return (payload: unknown) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.post(destination.href).pipe(
        HttpClientRequest.bodyJsonUnsafe(payload),
        HttpClientRequest.setHeader("Idempotency-Key", crypto.randomUUID()),
      );
      const response = yield* HttpClient.execute(
        Option.isSome(secret) && Redacted.value(secret.value) !== ""
          ? HttpClientRequest.bearerToken(request, secret.value)
          : request,
      );
      if (response.status < 200 || response.status >= 300) return yield* new FeedbackUnavailable();
    });
});

/**
 * With neither a GitHub repository nor a webhook URL set, the existing analytics sink (including
 * its opt-out) is untouched. With both, the issue is filed first so the webhook can link it, and
 * feedback is accepted when either receiver took it.
 */
export const selfHostFeedbackWebhook = (origin: string) =>
  Effect.gen(function* () {
    const issues = yield* selfHostFeedbackIssues;
    const webhook = yield* webhookReceiver;
    if (issues === undefined && webhook === undefined) return undefined;
    const sql = yield* SqlClient.SqlClient;

    const submit: typeof ProductAnalytics.Service.submitFeedback = (feedback) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUsage;
        const rows = yield* sql`select email from "user" where id = ${feedback.userId}`;
        const person = Schema.decodeUnknownOption(Person)(rows[0]);
        const user = {
          id: feedback.userId,
          ...(Option.isSome(person) ? { email: person.value.email } : {}),
        };
        const submittedAt = DateTime.formatIso(yield* DateTime.now);
        const who = [user.email ?? user.id, caller.client_name]
          .filter(Boolean)
          .join(" / ")
          // One line: a client names itself, and must not add lines to an issue's sender list.
          .replace(/\s+/gu, " ")
          .slice(0, 300);
        const issue =
          issues === undefined
            ? Option.none<FeedbackIssue>()
            : yield* delivered(
                "GitHub issue",
                issues({
                  message: feedback.message,
                  submittedAt,
                  who,
                  source: caller.source,
                  organizationId: feedback.organizationId,
                  instanceOrigin: origin,
                }),
              );
        if (webhook === undefined) {
          if (Option.isNone(issue)) return yield* new FeedbackUnavailable();
          return;
        }
        const filed =
          issues === undefined
            ? ""
            : `\nIssue: ${Option.match(issue, { onNone: () => "not created", onSome: (created) => created.url })}`;
        const notified = yield* delivered(
          "webhook",
          webhook({
            message: feedback.message,
            submittedAt,
            organization: { id: feedback.organizationId },
            user,
            caller,
            instanceOrigin: origin,
            ...(Option.isSome(issue) ? { issue: issue.value } : {}),
            // Common notification receivers can consume these without a translation service.
            title: "Executor feedback",
            body: `${feedback.message.slice(0, 1500)}\nFrom: ${who}${filed}`,
          }),
        );
        if (Option.isNone(issue) && Option.isNone(notified))
          return yield* new FeedbackUnavailable();
      }).pipe(Effect.mapError(() => new FeedbackUnavailable()));
    return submit;
  });
