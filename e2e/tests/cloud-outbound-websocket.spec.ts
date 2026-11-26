import { expect, layer } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { scenarios } from "../test-plan.ts";

const echoServer = `
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    if (server.upgrade(request)) return;
    return new Response("ordinary response", { status: 202, headers: { "x-upstream": "echo" } });
  },
  websocket: {
    message(socket, message) {
      socket.send(message);
    },
  },
});
console.log(server.url.origin);
`;

const source = (origin: string) => `
import { defineApp, object, query, router, string } from "apps";

export default defineApp({}, {
  tools: router({
    echo: query({ input: object({ message: string() }) }, async (_ctx, { message }) => {
      const response = await fetch(${JSON.stringify(origin)}, { headers: { Upgrade: "websocket" } });
      const socket = response.webSocket;
      if (response.status !== 101 || !socket) {
        throw new Error("Expected a WebSocket upgrade, got " + response.status);
      }
      const reply = new Promise((resolve, reject) => {
        socket.addEventListener("message", (event) => resolve(event.data), { once: true });
        socket.addEventListener("close", () => reject(new Error("Socket closed before the echo")), { once: true });
        socket.addEventListener("error", () => reject(new Error("Socket failed before the echo")), { once: true });
      });
      socket.accept();
      try {
        socket.send(message);
        return { status: response.status, message: await reply };
      } finally {
        socket.close(1000);
      }
    }),
    http: query({ input: object({}) }, async () => {
      const response = await fetch(${JSON.stringify(origin)});
      return { status: response.status, upstream: response.headers.get("x-upstream"), text: await response.text() };
    }),
  }),
});`;

layer(HostedLive, { excludeTestServices: true })("Cloud outbound WebSocket", (it) => {
  it.effect(scenarios.cloudOutboundWebSocket.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const evidence = yield* Evidence;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const server = yield* processes.spawn(
          ChildProcess.make("bun", ["-e", echoServer], { stderr: "inherit" }),
        );
        const origin = yield* server.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
          Effect.map(Option.getOrThrowWith(() => new Error("Echo server exited before listening"))),
        );
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: "Outbound WebSocket",
          files: [{ path: "index.ts", content: source(origin) }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );

        const http = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "http",
          kind: "query",
          input: {},
        });
        yield* evidence.json("http.json", http);
        expect(http.status, JSON.stringify(http.body)).toBe(200);
        expect(http.body).toEqual({ status: 202, upstream: "echo", text: "ordinary response" });

        const message = "hello through the outbound gateway";
        const echoed = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "echo",
          kind: "query",
          input: { message },
        });
        yield* evidence.json("echo.json", echoed);
        expect(echoed.status, JSON.stringify(echoed.body)).toBe(200);
        expect(echoed.body).toEqual({ status: 101, message });
      }),
    ),
  );
});
