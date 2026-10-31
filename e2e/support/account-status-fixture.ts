/** Synthetic status endpoint. The app reaches it with its own backend account. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { interactiveAccountSource, interactiveBackendKey } from "./interactive-account-backend.ts";

export const displayedStatus = {
  badges: [
    { label: "Pro", tone: "neutral" },
    { label: "Available", tone: "good" },
  ],
  meters: [
    {
      label: "5h",
      remaining: 0.75,
      resetsAt: "2030-01-02T03:04:05Z",
      detail: "Shared request window",
    },
    { label: "Weekly", remaining: null, detail: "No weekly estimate" },
  ],
  stats: [
    { label: "Requests", value: "42" },
    { label: "Tokens", value: "12,345" },
    { label: "Cost", value: "$1.23" },
  ],
};

type Answer =
  | { readonly status: number; readonly body: Schema.Json }
  | { readonly status: "timeout" };
export const accountStatusBackend = Effect.gen(function* () {
  const answer = yield* Ref.make<Answer>({
    status: 200,
    body: {
      accountInfo: { displayName: "Checked fixture identity" },
      status: displayedStatus,
      privateCredential: "must-not-cross-the-check-boundary",
    },
  });
  const calls = yield* Ref.make(0);
  const routes = HttpRouter.add(
    "GET",
    "/check",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        request.headers.authorization !== `Bearer ${interactiveBackendKey}` ||
        !request.url.includes("ref=opaque-")
      )
        return HttpServerResponse.empty({ status: 401 });
      yield* Ref.update(calls, (value) => value + 1);
      const current = yield* Ref.get(answer);
      if (current.status === "timeout") return yield* Effect.never;
      return yield* HttpServerResponse.json(current.body, { status: current.status });
    }),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    calls: Ref.get(calls),
    answer: (value: Answer) => Ref.set(answer, value),
  };
});

export const accountStatusSource = (connectOrigin: string, checkOrigin: string, withCheck = true) =>
  interactiveAccountSource(connectOrigin)
    .replace(
      "defineApp, defineProvider, interactive,",
      "ProviderError, defineApp, defineProvider, interactive,",
    )
    .replace(
      JSON.stringify([new URL(connectOrigin).host]),
      JSON.stringify([new URL(connectOrigin).host, new URL(checkOrigin).host]),
    )
    .replace(
      "const handlers = {",
      withCheck
        ? `const handlers = {
  check: async (ctx: ConnectContext<typeof requirements>, input: { method: string; ref: string }) => {
    const backend = ctx.app.accounts.backend;
    if (backend === undefined) throw new Error("The backend account is missing");
    const response = await ctx.fetch(${JSON.stringify(checkOrigin + "/check")} + "?ref=" + encodeURIComponent(input.ref), {
      signal: ctx.signal, headers: backend.headers(),
    });
    if (!response.ok) throw new ProviderError({ reason: response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status === 429 ? "rate_limited" : "unavailable", status: response.status });
    return await response.json();
  },`
        : "const handlers = {",
    );
