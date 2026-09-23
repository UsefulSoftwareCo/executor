import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { UserFacingError, UnexpectedError } from "../src/user-facing-error.ts";

const Unavailable = UserFacingError.define({
  tag: "TestUnavailable",
  status: 503,
  title: "Service unavailable",
  description: "The service could not complete the check.",
  recovery: { action: "Try again.", instructions: "Check service availability, then retry." },
  retryable: true,
});
const InvalidSettings = UserFacingError.define({
  tag: "TestInvalidSettings",
  status: 422,
  fields: {
    reason: Schema.Literals(["missing", "invalid"]),
    privateDiagnostic: Schema.String,
  },
  presentation: ({ reason }) => ({
    title: reason === "missing" ? "Settings missing" : "Settings invalid",
    description: "The configured service needs different settings.",
    recovery: { action: "Check the settings.", instructions: "Inspect the provider definition." },
  }),
});

test("errors stay yieldable and retain their HTTP status and exact wire payload", () => {
  const error = new Unavailable();
  assert.equal(
    Effect.runSync(
      Effect.flip(
        Effect.gen(function* () {
          yield* error;
        }),
      ),
    ),
    error,
  );
  assert.equal(Schema.resolveAnnotations(Unavailable)?.httpApiStatus, 503);
  assert.deepEqual(Schema.encodeSync(Unavailable)(error), { _tag: "TestUnavailable" });
  assert.equal(error.message, error.description);
  assert.equal(error.retryable, true);
});

test("JSON decoding restores typed fields and error-owned recovery without copying diagnostics", () => {
  const error = new InvalidSettings({ reason: "missing", privateDiagnostic: "PRIVATE_VALUE" });
  const wire = Schema.encodeSync(InvalidSettings)(error);
  assert.deepEqual(wire, {
    _tag: "TestInvalidSettings",
    reason: "missing",
    privateDiagnostic: "PRIVATE_VALUE",
  });
  const decoded = Schema.decodeUnknownSync(InvalidSettings)(JSON.parse(JSON.stringify(wire)));
  assert.ok(decoded instanceof InvalidSettings);
  assert.ok(Schema.is(InvalidSettings)(decoded));
  assert.equal(decoded.reason, "missing");
  assert.equal(decoded.title, "Settings missing");
  assert.equal(decoded.code, "TestInvalidSettings");
  assert.equal(decoded.retryable, false);
  assert.equal(decoded.fixPrompt, error.fixPrompt);
  assert.match(decoded.fixPrompt, /Inspect the provider definition/);
  assert.match(decoded.fixPrompt, /Verify the failed operation/);
  assert.ok(!decoded.fixPrompt.includes("PRIVATE_VALUE"));
});

test("an API error union restores each constructor and ignores forged presentation fields", () => {
  const errors = Schema.Union([Unavailable, InvalidSettings]);
  const decoded = Schema.decodeUnknownSync(errors)({
    _tag: "TestInvalidSettings",
    reason: "invalid",
    privateDiagnostic: "PRIVATE_VALUE",
    title: "FORGED_TITLE",
    recovery: { action: "FORGED_ACTION", instructions: "FORGED_PROMPT" },
  });
  assert.ok(decoded instanceof InvalidSettings);
  assert.equal(decoded.title, "Settings invalid");
  assert.ok(!decoded.fixPrompt.includes("FORGED"));
  assert.throws(() => Schema.decodeUnknownSync(errors)({ _tag: "Unknown" }));
  assert.throws(() =>
    Schema.decodeUnknownSync(errors)({
      _tag: "TestInvalidSettings",
      reason: "other",
      privateDiagnostic: "PRIVATE_VALUE",
    }),
  );
});

test("unexpected failures have an independent safe fallback", () => {
  const error = new UnexpectedError();
  assert.equal(error.code, "UnexpectedError");
  assert.match(error.description, /unexpected error/);
  assert.match(error.fixPrompt, /does not establish a specific cause/);
});
