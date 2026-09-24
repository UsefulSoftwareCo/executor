import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Scope } from "effect";
import { oauthSetupIssuer } from "../e2e/support/oauth-setup-issuer.ts";

test("OAuth fixture releases a client with an unfinished HTTP request", async () => {
  const scope = Effect.runSync(Scope.make());
  const issuer = await Effect.runPromise(
    oauthSetupIssuer.pipe(Scope.provide(scope), Effect.provide(NodeServices.layer)),
  );
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(issuer.origin).port) });
  try {
    await once(socket, "connect");
    socket.write(
      "GET /mcp HTTP/1.1\r\nHost: localhost\r\n\r\nPOST /register HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{",
    );
    const [response] = await once(socket, "data");
    assert.match(String(response), /HTTP\/1.1 401/);
    const disconnected = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.on("error", () => {});
    });
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await disconnected;
    assert.equal(socket.destroyed, true);
  } finally {
    socket.destroy();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});
