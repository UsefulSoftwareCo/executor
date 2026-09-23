import { DurableObject } from "cloudflare:workers";
import { Effect, Result, Schema } from "effect";
import { makeFacetSupervisor, facetFailureCause } from "../../src/cloudflare.ts";
import code from "facet:code";

// Harness-only authentication. Every data operation uses the production supervisor implementation.
export class Supervisor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.supervisor = Effect.runSync(makeFacetSupervisor(ctx, env.LOADER));
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/cancel") {
      await Effect.runPromise(this.supervisor.cancel(url.searchParams.get("request")));
      return new Response("cancelled");
    }
    if (url.pathname === "/restart") {
      this.ctx.facets.abort("data", "restart");
      return new Response("ok");
    }
    if (url.pathname === "/pending") {
      // Simulate the supervisor dying after a child commit, before notification.
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      await this.ctx.storage.put("pending", true);
      return new Response("ok");
    }
    if (url.pathname === "/changes") {
      const pair = new WebSocketPair();
      await Effect.runPromise(this.supervisor.subscribe(pair[1]));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const body = await request.text();
    const input = Schema.decodeUnknownSync(Schema.Struct({ write: Schema.Boolean }))(
      JSON.parse(body),
    );
    const result = await Effect.runPromise(
      this.supervisor
        .invoke(
          {
            id: url.searchParams.get("request") ?? crypto.randomUUID(),
            identity: url.searchParams.get("version") ?? "synthetic-v1",
            bundle: { mainModule: "app.js", modules: { "app.js": code } },
            body,
            write: input.write,
            headers: {},
          },
          async () => ({ ok: true, response: { action: "accept", content: {} } }),
        )
        .pipe(Effect.result),
    );
    if (Result.isFailure(result)) {
      const cause = facetFailureCause(result.failure);
      console.error("Facet test failed", cause instanceof Error ? cause.message : String(cause));
      return Response.json(
        { diagnostic: cause instanceof Error ? cause.message : String(cause) },
        { status: 500 },
      );
    }
    const value = result.success;
    return Response.json(value, { status: value.ok ? 200 : 409 });
  }
  async alarm() {
    await Effect.runPromise(this.supervisor.recover);
  }
  webSocketMessage() {}
  webSocketClose(socket) {
    socket.close(1000, "Closed");
  }
  webSocketError(socket) {
    socket.close(1011, "Reconnect");
  }
}
export default {
  fetch(request, env) {
    if (!env.TEST_TOKEN || request.headers.get("authorization") !== `Bearer ${env.TEST_TOKEN}`)
      return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    const app = url.searchParams.get("app");
    if (app === null || !/^[a-z0-9-]{1,80}$/.test(app))
      return new Response("App required", { status: 400 });
    return env.ROOT.getByName(app).fetch(request);
  },
};
