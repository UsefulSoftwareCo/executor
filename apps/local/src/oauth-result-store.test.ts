import { afterEach, describe, expect, it } from "@effect/vitest";
import { OAUTH_POPUP_MESSAGE_TYPE, type OAuthPopupResult } from "@executor-js/sdk";

import {
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  __resetOAuthResultStoreForTests();
});

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
    await sleep(20);
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
    const result = await waitForOAuthResult("s-deadline", { timeoutMs: 30 });

    expect(result).toBeNull();
    expect(__oauthAwaitWaiterCountForTests("s-deadline")).toBe(0);
  });

  it("removes the waiter on abort and leaves a later result consumable", async () => {
    const controller = new AbortController();
    const pending = waitForOAuthResult("s-abort", {
      timeoutMs: 5000,
      signal: controller.signal,
    });
    await sleep(10);
    controller.abort();

    expect(await pending).toBeNull();
    expect(__oauthAwaitWaiterCountForTests("s-abort")).toBe(0);

    // The aborted waiter must not consume a result published afterwards.
    publishOAuthResult(sampleResult("s-abort"));
    expect(consumeOAuthResult("s-abort")).toMatchObject({ sessionId: "s-abort" });
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

  it("delivers one publish to exactly one of several concurrent waiters", async () => {
    const first = waitForOAuthResult("s-multi", { timeoutMs: 5000 });
    const second = waitForOAuthResult("s-multi", { timeoutMs: 5000 });
    await sleep(10);
    expect(__oauthAwaitWaiterCountForTests("s-multi")).toBe(2);

    publishOAuthResult(sampleResult("s-multi"));
    const results = await Promise.all([first, second]);

    const delivered = results.filter((result) => result !== null);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ sessionId: "s-multi" });
    expect(consumeOAuthResult("s-multi")).toBeNull();
    expect(__oauthAwaitWaiterCountForTests("s-multi")).toBe(0);
  });
});
