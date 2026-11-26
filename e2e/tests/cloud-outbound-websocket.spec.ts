import { expect, layer } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { connectionsPath, linkAccount } from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { scenarios } from "../test-plan.ts";

const secretToken = "ws-secret-token";

const echoServer = `
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const auth = request.headers.get("authorization");
    if (server.upgrade(request, { data: { auth } })) return;
    if (new URL(request.url).pathname === "/empty") {
      return new Response(null, { status: 204, headers: { "x-upstream": "empty" } });
    }
    return new Response("ordinary response", { status: 202, headers: { "x-upstream": "echo" } });
  },
  websocket: {
    message(socket, message) {
      const auth = socket.data?.auth;
      const prefix = auth === null ? "" : auth === ${JSON.stringify(`Bearer ${secretToken}`)} ? "authed:" : "bad-auth:";
      socket.send(prefix + message);
    },
  },
});
console.log(server.url.origin);
`;

const source = (origin: string, host: string) => `
import { defineApp, defineProvider, object, query, router, secrets, string } from "apps";

const service = defineProvider({
  name: "WebSocket Echo",
  hosts: [${JSON.stringify(host)}],
  auth: {
    key: secrets({
      label: "Key",
      fields: object({ token: string() }),
    }),
  },
});

const exchange = async (socket, message, accept) => {
  const reply = new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(event.data), { once: true });
    socket.addEventListener("close", () => reject(new Error("Socket closed before the echo")), { once: true });
    socket.addEventListener("error", () => reject(new Error("Socket failed before the echo")), { once: true });
  });
  if (accept) {
    socket.accept();
    try {
      socket.send(message);
      return await reply;
    } finally {
      socket.close(1000);
    }
  }
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(undefined), { once: true });
    socket.addEventListener("close", () => reject(new Error("Socket closed before opening")), { once: true });
    socket.addEventListener("error", () => reject(new Error("Socket failed before opening")), { once: true });
  });
  try {
    socket.send(message);
    return await reply;
  } finally {
    socket.close(1000);
  }
};

export default defineApp({ user: { accounts: { service } } }, {
  tools: router({
    echo: query({ input: object({ message: string() }) }, async (_ctx, { message }) => {
      const response = await fetch(${JSON.stringify(origin)}, { headers: { Upgrade: "websocket" } });
      const socket = response.webSocket;
      if (response.status !== 101 || !socket) {
        throw new Error("Expected a WebSocket upgrade, got " + response.status);
      }
      return { status: response.status, message: await exchange(socket, message, true) };
    }),
    socket: query({ input: object({ message: string() }) }, async (_ctx, { message }) => {
      const ws = new WebSocket(${JSON.stringify(origin.replace(/^http:/u, "ws:"))});
      return { message: await exchange(ws, message, false) };
    }),
    authedEcho: query({ input: object({ message: string() }) }, async (ctx, { message }) => {
      const response = await fetch(${JSON.stringify(origin)}, {
        headers: {
          Upgrade: "websocket",
          authorization: "Bearer " + ctx.user.accounts.service.fields.token,
        },
      });
      const socket = response.webSocket;
      if (response.status !== 101 || !socket) {
        throw new Error("Expected an authenticated WebSocket upgrade, got " + response.status);
      }
      return { status: response.status, message: await exchange(socket, message, true) };
    }),
    http: query({ input: object({}) }, async () => {
      const response = await fetch(${JSON.stringify(origin)});
      const empty = await fetch(${JSON.stringify(`${origin}/empty`)});
      return {
        status: response.status,
        upstream: response.headers.get("x-upstream"),
        text: await response.text(),
        emptyStatus: empty.status,
        emptyUpstream: empty.headers.get("x-upstream"),
      };
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
        const orgPrefix = `/api/organizations/${actors.organization.id}`;
        const prefix = `${orgPrefix}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: "Outbound WebSocket",
          files: [
            { path: "index.ts", content: source(origin, new URL(origin).host) },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );

        const pending = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(path, "user", "service"),
          {},
        );
        expect(pending.status, JSON.stringify(pending.body)).toBe(200);
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${orgPrefix}/connections/${(yield* body(Resource, pending)).id}/submit`,
          { method: "key", label: "Echo Key", fields: { token: secretToken } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const account = (yield* body(Resource, saved)).id;
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${orgPrefix}/accounts/${account}`)
            .pipe(Effect.orDie),
        );
        yield* linkAccount(actors.owner, path, "service", account);

        const http = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "http",
          kind: "query",
          input: {},
        });
        yield* evidence.json("http.json", http);
        expect(http.status, JSON.stringify(http.body)).toBe(200);
        expect(http.body).toEqual({
          status: 202,
          upstream: "echo",
          text: "ordinary response",
          emptyStatus: 204,
          emptyUpstream: "empty",
        });

        const message = "hello through the outbound gateway";
        const echoed = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "echo",
          kind: "query",
          input: { message },
        });
        yield* evidence.json("echo.json", echoed);
        expect(echoed.status, JSON.stringify(echoed.body)).toBe(200);
        expect(echoed.body).toEqual({ status: 101, message });

        const socketed = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "socket",
          kind: "query",
          input: { message },
        });
        yield* evidence.json("socket.json", socketed);
        expect(socketed.status, JSON.stringify(socketed.body)).toBe(200);
        expect(socketed.body).toEqual({ message });

        const authed = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "authedEcho",
          kind: "query",
          input: { message },
        });
        yield* evidence.json("authed.json", authed);
        expect(authed.status, JSON.stringify(authed.body)).toBe(200);
        expect(authed.body).toEqual({ status: 101, message: `authed:${message}` });
      }),
    ),
  );
});
