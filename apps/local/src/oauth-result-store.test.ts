import { afterEach, describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- boundary: deterministic timer control comes from vitest itself
import { vi } from "vitest";
import { OAUTH_POPUP_MESSAGE_TYPE, type OAuthPopupResult } from "@executor-js/sdk";

import {
  __oauthAwaitHeldWaiterTotalForTests,
  __oauthAwaitWaiterCountForTests,
  __resetOAuthResultStoreForTests,
  consumeOAuthResult,
  publishOAuthResult,
  waitForOAuthResult,
} from "./oauth-result-store";

const sampleResult = (sessionId: string): OAuthPopupResult<unknown> => ({
  type: OAUTH_POPUP_MESSAGE_TYPE,
  ok: false,
  sessionId,
  error: "access denied",
});

afterEach(() => {
  __resetOAuthResultStoreForTests();
  vi.useRealTimers();
});

// Waiter registration, publish wake-ups, aborts, and the over-cap instant
// answer are all synchronous, so every ordering below is exact — no sleeps.

describe("waitForOAuthResult", () => {
  it("resolves immediately and consumes when the result is already published", async () => {
    publishOAuthResult(sampleResult("s-ready"));

    const result = await waitForOAuthResult("s-ready", { timeoutMs: 5000 });

    expect(result).toMatchObject({ sessionId: "s-ready" });
    // One-shot: the wait consumed the entry.
    expect(consumeOAuthResult("s-ready")).toBeNull();
    expect(__oauthAwaitWaiterCountForTests("s-ready")).toBe(0);
  });

  it("resolves a held wait the moment the result is published", async () => {
    const pending = waitForOAuthResult("s-mid", { timeoutMs: 5000 });
    expect(__oauthAwaitWaiterCountForTests("s-mid")).toBe(1);

    const publishedAt = Date.now();
    publishOAuthResult(sampleResult("s-mid"));
    const result = await pending;

    // Resolved by the publish, not the 5s deadline.
    expect(Date.now() - publishedAt).toBeLessThan(1000);
    expect(result).toMatchObject({ sessionId: "s-mid" });
    expect(consumeOAuthResult("s-mid")).toBeNull();
    expect(__oauthAwaitWaiterCountForTests("s-mid")).toBe(0);
  });

  it("returns null at the deadline and removes the waiter", async () => {
    vi.useFakeTimers();
    const pending = waitForOAuthResult("s-deadline", { timeoutMs: 25_000 });
    expect(__oauthAwaitWaiterCountForTests("s-deadline")).toBe(1);

    vi.advanceTimersByTime(25_000);

    expect(await pending).toBeNull();
    expect(__oauthAwaitWaiterCountForTests("s-deadline")).toBe(0);
  });

  it("resolves immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await waitForOAuthResult("s-pre-aborted", {
      timeoutMs: 5000,
      signal: controller.signal,
    });

    expect(result).toBeNull();
    expect(__oauthAwaitWaiterCountForTests("s-pre-aborted")).toBe(0);
  });
});

describe("waitForOAuthResult publish/abort races", () => {
  it("abort settles first; a publish arriving after leaves the result for the next consumer", async () => {
    const controller = new AbortController();
    const pending = waitForOAuthResult("s-abort-first", {
      timeoutMs: 5000,
      signal: controller.signal,
    });
    expect(__oauthAwaitWaiterCountForTests("s-abort-first")).toBe(1);

    controller.abort();
    expect(await pending).toBeNull();
    expect(__oauthAwaitWaiterCountForTests("s-abort-first")).toBe(0);

    // The publish lands after the abort settled: the dead waiter must not
    // consume it — it stays in the store for the client's next poll.
    publishOAuthResult(sampleResult("s-abort-first"));
    expect(consumeOAuthResult("s-abort-first")).toMatchObject({ sessionId: "s-abort-first" });
  });

  it("publish resolves the waiter; an abort firing immediately after does not double-consume", async () => {
    const controller = new AbortController();
    const pending = waitForOAuthResult("s-pub-first", {
      timeoutMs: 5000,
      signal: controller.signal,
    });
    expect(__oauthAwaitWaiterCountForTests("s-pub-first")).toBe(1);

    publishOAuthResult(sampleResult("s-pub-first"));
    controller.abort();

    expect(await pending).toMatchObject({ sessionId: "s-pub-first" });
    expect(__oauthAwaitWaiterCountForTests("s-pub-first")).toBe(0);

    // The late abort must not have consumed or dropped anything: a second
    // publish for the session is still delivered intact.
    publishOAuthResult(sampleResult("s-pub-first"));
    expect(consumeOAuthResult("s-pub-first")).toMatchObject({ sessionId: "s-pub-first" });
  });
});

describe("waitForOAuthResult publish/timeout races", () => {
  it("deadline fires first; a publish just after leaves the result consumable", async () => {
    vi.useFakeTimers();
    const pending = waitForOAuthResult("s-late-pub", { timeoutMs: 25_000 });
    expect(__oauthAwaitWaiterCountForTests("s-late-pub")).toBe(1);

    vi.advanceTimersByTime(25_000);
    expect(await pending).toBeNull();
    expect(__oauthAwaitWaiterCountForTests("s-late-pub")).toBe(0);

    publishOAuthResult(sampleResult("s-late-pub"));
    expect(consumeOAuthResult("s-late-pub")).toMatchObject({ sessionId: "s-late-pub" });
  });

  it("publish resolves the waiter; the stale deadline timer is inert afterwards", async () => {
    vi.useFakeTimers();
    const pending = waitForOAuthResult("s-early-pub", { timeoutMs: 25_000 });
    expect(__oauthAwaitWaiterCountForTests("s-early-pub")).toBe(1);

    publishOAuthResult(sampleResult("s-early-pub"));
    expect(await pending).toMatchObject({ sessionId: "s-early-pub" });
    expect(__oauthAwaitWaiterCountForTests("s-early-pub")).toBe(0);

    // Run the clock past the original deadline: the settled waiter's timer
    // was cleared, so nothing re-fires, re-registers, or consumes again.
    vi.advanceTimersByTime(25_000);
    expect(__oauthAwaitWaiterCountForTests("s-early-pub")).toBe(0);
    publishOAuthResult(sampleResult("s-early-pub"));
    expect(consumeOAuthResult("s-early-pub")).toMatchObject({ sessionId: "s-early-pub" });
  });
});

describe("waitForOAuthResult held-waiter caps", () => {
  it("holds one waiter per session; stacked requests answer null immediately (old-client behavior)", async () => {
    // An unpatched desktop client polls every second and would stack ~25
    // concurrent requests per flow against a holding server. Only the first
    // may hold; the rest get the pre-long-poll instant "still pending".
    const held = waitForOAuthResult("s-stack", { timeoutMs: 5000 });
    expect(__oauthAwaitWaiterCountForTests("s-stack")).toBe(1);

    const stacked = [
      waitForOAuthResult("s-stack", { timeoutMs: 5000 }),
      waitForOAuthResult("s-stack", { timeoutMs: 5000 }),
      waitForOAuthResult("s-stack", { timeoutMs: 5000 }),
    ];
    // The stacked requests settle null BEFORE any publish — instant answers.
    for (const request of stacked) expect(await request).toBeNull();
    expect(__oauthAwaitWaiterCountForTests("s-stack")).toBe(1);
    expect(__oauthAwaitHeldWaiterTotalForTests()).toBe(1);

    publishOAuthResult(sampleResult("s-stack"));
    // Exactly one consumer receives the one-shot result: the held waiter.
    expect(await held).toMatchObject({ sessionId: "s-stack" });
    expect(consumeOAuthResult("s-stack")).toBeNull();
    // No leaked waiters after the flow.
    expect(__oauthAwaitWaiterCountForTests("s-stack")).toBe(0);
    expect(__oauthAwaitHeldWaiterTotalForTests()).toBe(0);
  });

  it("re-arms the per-session hold after the held waiter settles", async () => {
    const controller = new AbortController();
    const first = waitForOAuthResult("s-rearm", { timeoutMs: 5000, signal: controller.signal });
    // Over the per-session cap while the first is held.
    expect(await waitForOAuthResult("s-rearm", { timeoutMs: 5000 })).toBeNull();

    controller.abort();
    expect(await first).toBeNull();
    expect(__oauthAwaitWaiterCountForTests("s-rearm")).toBe(0);

    // The slot is free again: the next request holds and gets the result.
    const second = waitForOAuthResult("s-rearm", { timeoutMs: 5000 });
    expect(__oauthAwaitWaiterCountForTests("s-rearm")).toBe(1);
    publishOAuthResult(sampleResult("s-rearm"));
    expect(await second).toMatchObject({ sessionId: "s-rearm" });
    expect(__oauthAwaitWaiterCountForTests("s-rearm")).toBe(0);
  });

  it("caps total held waiters globally; over-cap sessions answer instantly but stored results still deliver", async () => {
    const held = Array.from({ length: 64 }, (_, index) =>
      waitForOAuthResult(`s-global-${index}`, { timeoutMs: 5000 }),
    );
    expect(__oauthAwaitHeldWaiterTotalForTests()).toBe(64);

    // A distinct pending session over the global cap answers null instantly
    // instead of holding.
    expect(await waitForOAuthResult("s-global-over", { timeoutMs: 5000 })).toBeNull();
    expect(__oauthAwaitHeldWaiterTotalForTests()).toBe(64);

    // Over-cap behavior matches the pre-long-poll server exactly: a result
    // already in the store is still consumed and answered immediately.
    publishOAuthResult(sampleResult("s-global-stored"));
    expect(await waitForOAuthResult("s-global-stored", { timeoutMs: 5000 })).toMatchObject({
      sessionId: "s-global-stored",
    });

    // Settle every held waiter and confirm the registry drains completely.
    __resetOAuthResultStoreForTests();
    for (const request of held) expect(await request).toBeNull();
    expect(__oauthAwaitHeldWaiterTotalForTests()).toBe(0);
  });
});
