import { Effect, Match, Schema } from "effect";

const ApprovalRequestId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^apr_[\s\S]+$/u)),
  Schema.brand("apr"),
);
const ToolResumeResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    value: Schema.Json,
    toolError: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({ status: Schema.Literal("denied"), requestId: ApprovalRequestId }),
  Schema.Struct({ status: Schema.Literal("cancelled"), requestId: ApprovalRequestId }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    requestId: ApprovalRequestId,
    reason: Schema.Literals(["expired", "context-changed", "execution-failed"]),
  }),
  Schema.Struct({ status: Schema.Literal("already-consumed"), requestId: ApprovalRequestId }),
]);
const ToolRunAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("answered"), result: ToolResumeResult }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
type ToolRunAnswer = typeof ToolRunAnswer.Encoded;

export const previousServerAnswers = (
  requestId: string,
): ReadonlyArray<readonly [label: string, answer: ToolRunAnswer]> => [
  [
    "execution-failed",
    { status: "answered", result: { status: "failed", requestId, reason: "execution-failed" } },
  ],
  ["completed", { status: "answered", result: { status: "completed", value: { ok: true } } }],
  [
    "completed with a tool error",
    { status: "answered", result: { status: "completed", value: "failed", toolError: true } },
  ],
  ["denied", { status: "answered", result: { status: "denied", requestId } }],
  ["cancelled", { status: "answered", result: { status: "cancelled", requestId } }],
  ["expired", { status: "answered", result: { status: "failed", requestId, reason: "expired" } }],
  [
    "context-changed",
    { status: "answered", result: { status: "failed", requestId, reason: "context-changed" } },
  ],
  ["already-consumed", { status: "answered", result: { status: "already-consumed", requestId } }],
  ["unavailable", { status: "unavailable" }],
];

const answered = (result: typeof ToolResumeResult.Type) =>
  Match.value(result).pipe(
    Match.discriminatorsExhaustive("status")({
      completed: ({ toolError }) =>
        toolError === true
          ? "Approved. The tool ran and reported an error, shown below."
          : "Approved. The tool ran, and its result is below.",
      denied: () => "Declined. Executor will not resume this saved call.",
      cancelled: () => "Cancelled. Executor will not resume this saved call.",
      failed: ({ reason }) =>
        Match.value(reason).pipe(
          Match.when(
            "context-changed",
            () =>
              "The app, profile or accounts changed since this call was saved, so Executor did not resume it. Run it again to review the current call.",
          ),
          Match.when(
            "execution-failed",
            () =>
              "The tool failed after you approved it. It may have already made changes. Check before running it again.",
          ),
          Match.when(
            "expired",
            () => "This request expired, so Executor will not resume this saved call.",
          ),
          Match.exhaustive,
        ),
      "already-consumed": () => "This request was already answered.",
    }),
  );

export const previousToolRunCompletion = (body: unknown) =>
  Schema.decodeUnknownEffect(ToolRunAnswer)(body).pipe(
    Effect.map((answer) => (answer.status === "answered" ? answered(answer.result) : undefined)),
    Effect.catchTag("SchemaError", () => Effect.succeed("Cannot reach Executor. Try again.")),
  );
export const isPreviousServerAnswer = Schema.is(ToolRunAnswer);
