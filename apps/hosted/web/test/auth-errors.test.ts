import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { authRequest } from "../src/contracts/auth.ts";

const failed = (status: number, code?: string) =>
  Effect.runPromise(
    authRequest(() =>
      Promise.resolve({
        data: null,
        error: {
          status,
          ...(code === undefined ? {} : { code }),
          message: "synthetic-private-upstream-message",
        },
      }),
    ).pipe(Effect.flip),
  );

test("auth failures retain safe codes and distinguish expired from incorrect codes", async () => {
  const expired = await failed(400, "OTP_EXPIRED");
  const incorrect = await failed(400, "INVALID_OTP");
  assert.equal(expired.code, "OTP_EXPIRED");
  assert.equal(expired.status, 400);
  assert.match(expired.message, /expired.*new code/);
  assert.match(incorrect.message, /incorrect/);
  assert.ok(!JSON.stringify(expired).includes("synthetic-private-upstream-message"));
});

test("only the password error code uses password-specific copy", async () => {
  assert.doesNotMatch((await failed(401, "AUTHENTICATION_FAILED")).message, /password/);
  assert.match((await failed(401, "INVALID_EMAIL_OR_PASSWORD")).message, /password/);
  assert.match((await failed(429)).message, /Too many attempts/);
});

test("network exceptions stay private and successes pass through", async () => {
  const error = await Effect.runPromise(
    authRequest(() => Promise.reject(new Error("synthetic-private-network-message"))).pipe(
      Effect.flip,
    ),
  );
  assert.equal(error.status, undefined);
  assert.equal(error.code, undefined);
  assert.match(error.message, /Cannot reach/);
  assert.ok(!JSON.stringify(error).includes("synthetic-private-network-message"));
  assert.equal(
    await Effect.runPromise(authRequest(() => Promise.resolve({ data: "ok", error: null }))),
    "ok",
  );
});
