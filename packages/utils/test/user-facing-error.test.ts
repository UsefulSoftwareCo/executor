import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Schema } from "effect";
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
    description:
      reason === "missing"
        ? "Required settings are missing."
        : "The configured service needs different settings.",
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
  assert.deepEqual(Schema.encodeSync(Unavailable)(error), {
    _tag: "TestUnavailable",
    message: "The service could not complete the check.",
  });
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
    message: "Required settings are missing.",
  });
  const decoded = Schema.decodeUnknownSync(InvalidSettings)(JSON.parse(JSON.stringify(wire)));
  assert.ok(decoded instanceof InvalidSettings);
  assert.ok(Schema.is(InvalidSettings)(decoded));
  assert.equal(decoded.reason, "missing");
  assert.equal(decoded.title, "Settings missing");
  assert.equal(decoded.message, "Required settings are missing.");
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
    message: "FORGED_MESSAGE",
    title: "FORGED_TITLE",
    recovery: { action: "FORGED_ACTION", instructions: "FORGED_PROMPT" },
  });
  assert.ok(decoded instanceof InvalidSettings);
  assert.equal(decoded.title, "Settings invalid");
  assert.equal(decoded.message, "The configured service needs different settings.");
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

test("native makers retain constructor defaults, safe messages, and existing instances", () => {
  const Defaulted = UserFacingError.define({
    tag: "TestDefaulted",
    status: 422,
    fields: {
      reason: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("missing"))),
    },
    presentation: ({ reason }) => ({
      title: "Settings unavailable",
      description: `Settings are ${reason}.`,
      recovery: { action: "Check settings.", instructions: "Check the configuration." },
    }),
  });
  for (const error of [
    new Defaulted(),
    Defaulted.make({}),
    Effect.runSync(Defaulted.makeEffect({})),
    Defaulted.makeOption({}).pipe(Option.getOrThrow),
  ]) {
    assert.equal(error.message, "Settings are missing.");
    assert.equal(Defaulted.make(error), error);
    assert.deepEqual(Schema.encodeSync(Defaulted)(error), {
      _tag: "TestDefaulted",
      reason: "missing",
      message: "Settings are missing.",
    });
  }
});

test("typed clients can decode both the old and new response shapes", () => {
  class LegacyUnavailable extends Schema.TaggedError<LegacyUnavailable>()("TestUnavailable", {}) {}
  const wire = Schema.encodeSync(Unavailable)(new Unavailable());
  assert.ok(Schema.decodeUnknownSync(LegacyUnavailable)(wire) instanceof LegacyUnavailable);
  assert.equal(
    Schema.decodeUnknownSync(Unavailable)({ _tag: "TestUnavailable" }).message,
    wire.message,
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(Unavailable)({ _tag: "TestUnavailable", message: 42 }),
  );
});
