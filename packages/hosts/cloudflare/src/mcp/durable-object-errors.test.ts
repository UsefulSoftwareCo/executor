// oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: every case here is a verbatim reproduction of a plain Error the Cloudflare runtime itself throws, and the test helper throws to abort a case whose premise did not hold
import { describe, expect, it } from "@effect/vitest";
import { Cause } from "effect";

import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "@executor-js/host-mcp";

import { classifyDurableObjectError, durableObjectFailureResponse } from "./durable-object-errors";

// Every string here is a real Cloudflare runtime message. They arrive as plain
// `Error`s with no code, no type and no marker of any kind — the text IS the
// contract, which is exactly why it deserves one place and a test.
describe("classifyDurableObjectError", () => {
  it("reads a self-abort as a session that is gone for good", () => {
    // `destroy()` ends in `ctx.abort("destroyed")`; the abort reason arrives
    // verbatim as the error message.
    expect(classifyDurableObjectError(new Error("destroyed"))).toEqual({
      kind: "destroyed",
      disposition: "session_dead",
    });
  });

  it("reads a deploy-time reset as transient", () => {
    expect(
      classifyDurableObjectError(new Error("Durable Object reset because its code was updated.")),
    ).toEqual({ kind: "code_update", disposition: "transient" });
  });

  it("reads a storage timeout reset as transient", () => {
    expect(
      classifyDurableObjectError(
        new Error(
          "Durable Object storage operation exceeded timeout which caused object to be reset.",
        ),
      ),
    ).toEqual({ kind: "storage_timeout", disposition: "transient" });
  });

  it("reads a storage backend fault as transient", () => {
    expect(
      classifyDurableObjectError(
        new Error("Internal error in Durable Object storage caused object to be reset."),
      ),
    ).toEqual({ kind: "storage_internal", disposition: "transient" });
  });

  it("reads a blockConcurrencyWhile cancellation as transient", () => {
    expect(
      classifyDurableObjectError(
        new Error(
          "A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.",
        ),
      ),
    ).toEqual({ kind: "concurrency_reset", disposition: "transient" });
  });

  it("reads a platform blip as transient, ignoring the reference id", () => {
    // The reference id differs on every event; it must not defeat the match.
    expect(
      classifyDurableObjectError(new Error("internal error; reference = 0000aaaa1111bbbb")),
    ).toEqual({ kind: "internal_error", disposition: "transient" });
    expect(
      classifyDurableObjectError(new Error("internal error; reference = ffff9999eeee8888")),
    ).toEqual({ kind: "internal_error", disposition: "transient" });
  });

  it("honours the runtime's own retryable flag when the message says nothing", () => {
    const error = Object.assign(new Error("Network connection lost."), { retryable: true });
    expect(classifyDurableObjectError(error)).toEqual({
      kind: "retryable",
      disposition: "transient",
    });
  });

  it("looks inside an Effect cause, because that is how the DO seam sees it", () => {
    const cause = Cause.die(new Error("Durable Object reset because its code was updated."));

    expect(classifyDurableObjectError(cause)).toEqual({
      kind: "code_update",
      disposition: "transient",
    });
  });

  it("unwraps a wrapped platform error", () => {
    const wrapped = new Error("session restore failed", {
      cause: new Error("Durable Object reset because its code was updated."),
    });
    expect(classifyDurableObjectError(wrapped)).toEqual({
      kind: "code_update",
      disposition: "transient",
    });
  });

  // The whole point of returning null is that unknown failures keep their
  // current behaviour: rethrown, reported, paged. Silently swallowing an
  // application bug as "transient" would be far worse than the noise this
  // module removes.
  it("refuses to classify anything it does not recognize", () => {
    expect(classifyDurableObjectError(new Error("Cannot read properties of undefined"))).toBeNull();
    expect(classifyDurableObjectError(new TypeError("x is not a function"))).toBeNull();
    expect(classifyDurableObjectError(undefined)).toBeNull();
    expect(classifyDurableObjectError(null)).toBeNull();
    expect(classifyDurableObjectError({})).toBeNull();
  });

  // "destroyed" is the abort reason and nothing else. A message that merely
  // mentions the word describes a different failure and must not be allowed to
  // condemn a live session id.
  it("does not condemn a session for a message that merely mentions destruction", () => {
    expect(
      classifyDurableObjectError(new Error("the widget was destroyed by the user")),
    ).toBeNull();
  });
});

// What a client actually receives when the platform takes a session Durable
// Object away mid-request. The cloud e2e suite proves the reachable half of
// this black-box — a terminated session id always answers with a protocol
// envelope, never a bare 500 — but the dev stack never produces the platform
// errors themselves (an isolate abort, a deploy reset, a storage timeout), so
// the mapping from those errors to the wire response is pinned here.
describe("durableObjectFailureResponse", () => {
  const envelope = async (
    error: unknown,
  ): Promise<{
    readonly status: number;
    readonly retryAfter: string | null;
    readonly body: {
      readonly jsonrpc?: string;
      readonly error?: {
        readonly code?: number;
        readonly message?: string;
        readonly data?: unknown;
      };
    };
  }> => {
    const failure = classifyDurableObjectError(error);
    if (!failure) throw new Error("expected the error to be classified as a platform failure");
    const response = durableObjectFailureResponse(failure);
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body: await response.json(),
    };
  };

  // `destroy()` ends in `ctx.abort("destroyed")`. That rejection used to escape
  // the unguarded ownership RPC in the cloud MCP handler, so a client got a
  // bare 500 for a session it had itself just terminated.
  it("tells the client to reconnect when the session object is gone for good", async () => {
    const result = await envelope(new Error("destroyed"));

    expect(result.status, "the id is dead, not retryable").toBe(404);
    expect(result.body.jsonrpc).toBe("2.0");
    expect(result.body.error?.code).toBe(-32001);
    expect(result.body.error?.message).toBe("Session timed out, please reconnect");
  });

  // A deploy resets every live Durable Object. The session id is still valid,
  // so the client must be told to retry it — and told how long to wait, or the
  // 503 is not actionable.
  it("tells the client to retry the same session after a transient platform reset", async () => {
    const result = await envelope(new Error("Durable Object reset because its code was updated."));

    expect(result.status, "HTTP status is the discriminator clients act on").toBe(503);
    expect(result.body.jsonrpc).toBe("2.0");
    expect(result.body.error?.code).toBe(-32001);
    // `retryAfterSeconds` renders as the standard `Retry-After` header, which
    // is what a polite client (and any generic retry layer) actually reads.
    expect(result.retryAfter, "the client is told how long to back off").toBe(
      String(UNAVAILABLE_RETRY_AFTER_SECONDS),
    );
  });

  it("renders the same retry verdict for a storage timeout and a backend blip", async () => {
    for (const message of [
      "Durable Object storage operation exceeded timeout which caused object to be reset.",
      "internal error; reference = 0000aaaa1111bbbb",
      "A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.",
    ]) {
      const result = await envelope(new Error(message));
      expect(result.status, message).toBe(503);
      expect(result.retryAfter, message).not.toBeNull();
    }
  });
});
