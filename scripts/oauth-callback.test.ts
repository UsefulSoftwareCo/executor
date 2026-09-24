import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { Effect } from "effect";
import { oauthCallback } from "../e2e/support/mcp-oauth.ts";

test("OAuth receiver cleanup closes a browser preconnect without waiting for HTTP", async () => {
  let socket: Socket | undefined;
  let closed = false;
  const cleanup = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const receiver = yield* oauthCallback("synthetic-state");
        const connection = connect(Number(new URL(receiver.url).port), "127.0.0.1");
        socket = connection;
        yield* Effect.promise(() => once(connection, "connect"));
      }),
    ),
  ).then(() => {
    closed = true;
  });
  try {
    await Promise.race([cleanup, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
    assert.equal(closed, true, "the receiver retained an idle browser connection");
  } finally {
    socket?.destroy();
    await cleanup;
  }
});
