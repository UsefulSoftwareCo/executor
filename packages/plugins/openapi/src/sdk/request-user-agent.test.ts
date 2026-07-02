import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import { invokeWithLayer } from "./invoke";
import { OperationBinding, OperationParameter } from "./types";

// Captures the headers of the real outbound request the invoke path sends.
const withServer = <A>(
  f: (input: { readonly baseUrl: string; readonly headers: IncomingHttpHeaders[] }) => Promise<A>,
) =>
  new Promise<A>((resolve, reject) => {
    const headers: IncomingHttpHeaders[] = [];
    const server: Server = createServer((request, response) => {
      headers.push(request.headers);
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: Node listen callback is adapted into the test Promise failure path
        reject(new Error("Server did not bind to a TCP port"));
        return;
      }
      f({ baseUrl: `http://127.0.0.1:${address.port}`, headers })
        .then(resolve, reject)
        .finally(() => server.close());
    });
  });

const pathParam = (name: string) =>
  OperationParameter.make({
    name,
    location: "path",
    required: true,
    schema: Option.some({ type: "string" }),
    style: Option.none(),
    explode: Option.none(),
    allowReserved: Option.none(),
    description: Option.none(),
  });

// GitHub 403s any request without a User-Agent header, which downstream looks
// identical to a credential rejection. The invoke path must always send one.
it.effect("sends a default User-Agent so upstreams like GitHub don't 403", () =>
  Effect.promise(() =>
    withServer(async ({ baseUrl, headers }) => {
      const operation = OperationBinding.make({
        method: "get",
        servers: [],
        pathTemplate: "/repos/{owner}/{repo}/pulls",
        requestBody: Option.none(),
        responseBody: Option.none(),
        parameters: [pathParam("owner"), pathParam("repo")],
      });

      await Effect.runPromise(
        invokeWithLayer(
          operation,
          { owner: "risedle", repo: "aime" },
          baseUrl,
          {},
          {},
          FetchHttpClient.layer,
        ),
      );

      expect(headers[0]?.["user-agent"]).toBe("executor");
    }),
  ),
);

// A connection- or spec-provided User-Agent must still win over the default.
it.effect("lets a resolved User-Agent override the default", () =>
  Effect.promise(() =>
    withServer(async ({ baseUrl, headers }) => {
      const operation = OperationBinding.make({
        method: "get",
        servers: [],
        pathTemplate: "/ping",
        requestBody: Option.none(),
        responseBody: Option.none(),
        parameters: [],
      });

      await Effect.runPromise(
        invokeWithLayer(
          operation,
          {},
          baseUrl,
          { "User-Agent": "acme-app/2.0" },
          {},
          FetchHttpClient.layer,
        ),
      );

      expect(headers[0]?.["user-agent"]).toBe("acme-app/2.0");
    }),
  ),
);
