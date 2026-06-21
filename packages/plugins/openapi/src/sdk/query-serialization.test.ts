import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { createServer, type Server } from "node:http";

import { invokeWithLayer } from "./invoke";
import { OperationBinding, OperationParameter, ServerInfo } from "./types";

const withServer = <A>(
  f: (input: { readonly baseUrl: string; readonly requests: string[] }) => Promise<A>,
) =>
  new Promise<A>((resolve, reject) => {
    const requests: string[] = [];
    const server: Server = createServer((request, response) => {
      requests.push(request.url ?? "/");
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
      f({ baseUrl: `http://127.0.0.1:${address.port}`, requests })
        .then(resolve, reject)
        .finally(() => server.close());
    });
  });

it.effect("serializes form-exploded query arrays as repeated parameters", () =>
  Effect.promise(() =>
    withServer(async ({ baseUrl, requests }) => {
      const operation = OperationBinding.make({
        method: "get",
        servers: [],
        pathTemplate: "/messages/{id}",
        requestBody: Option.none(),
        responseBody: Option.none(),
        parameters: [
          OperationParameter.make({
            name: "id",
            location: "path",
            required: true,
            schema: Option.some({ type: "string" }),
            style: Option.none(),
            explode: Option.none(),
            allowReserved: Option.none(),
            description: Option.none(),
          }),
          OperationParameter.make({
            name: "metadataHeaders",
            location: "query",
            required: false,
            schema: Option.some({ type: "array", items: { type: "string" } }),
            style: Option.some("form"),
            explode: Option.some(true),
            allowReserved: Option.none(),
            description: Option.none(),
          }),
          OperationParameter.make({
            name: "fields",
            location: "query",
            required: false,
            schema: Option.some({ type: "array", items: { type: "string" } }),
            style: Option.some("form"),
            explode: Option.some(false),
            allowReserved: Option.none(),
            description: Option.none(),
          }),
        ],
      });

      await Effect.runPromise(
        invokeWithLayer(
          operation,
          {
            id: "abc",
            metadataHeaders: ["From", "Subject", "Date"],
            fields: ["id", "payload"],
          },
          baseUrl,
          {},
          {},
          FetchHttpClient.layer,
        ),
      );

      const url = new URL(requests[0]!, "http://executor.test");
      expect(url.pathname).toBe("/messages/abc");
      expect(url.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject", "Date"]);
      expect(url.searchParams.get("fields")).toBe("id,payload");
    }),
  ),
);

it.effect("uses operation base URL and preserves reserved path expansion when allowed", () =>
  Effect.promise(() =>
    withServer(async ({ baseUrl, requests }) => {
      const operation = OperationBinding.make({
        method: "get",
        servers: [
          ServerInfo.make({ url: baseUrl, description: Option.none(), variables: Option.none() }),
        ],
        pathTemplate: "/v1/{+name}",
        requestBody: Option.none(),
        responseBody: Option.none(),
        parameters: [
          OperationParameter.make({
            name: "name",
            location: "path",
            required: true,
            schema: Option.some({ type: "string" }),
            style: Option.none(),
            explode: Option.none(),
            allowReserved: Option.some(true),
            description: Option.none(),
          }),
        ],
      });

      await Effect.runPromise(
        invokeWithLayer(
          operation,
          {
            name: "spaces/AAA/messages/BBB",
          },
          // No connection override → the request targets the operation's server.
          "",
          {},
          {},
          FetchHttpClient.layer,
        ),
      );

      const url = new URL(requests[0]!, "http://executor.test");
      expect(url.pathname).toBe("/v1/spaces/AAA/messages/BBB");
    }),
  ),
);

it.effect("targets the server chosen by the call's `server.url`", () =>
  Effect.promise(() =>
    withServer(async ({ baseUrl, requests }) => {
      const operation = OperationBinding.make({
        method: "get",
        // First server is a dead host; the call must select the live one.
        servers: [
          ServerInfo.make({
            url: "https://unused.example",
            description: Option.none(),
            variables: Option.none(),
          }),
          ServerInfo.make({ url: baseUrl, description: Option.none(), variables: Option.none() }),
        ],
        pathTemplate: "/ping",
        requestBody: Option.none(),
        responseBody: Option.none(),
        parameters: [],
      });

      await Effect.runPromise(
        invokeWithLayer(operation, { server: { url: baseUrl } }, "", {}, {}, FetchHttpClient.layer),
      );

      const url = new URL(requests[0]!, "http://executor.test");
      expect(url.pathname).toBe("/ping");
    }),
  ),
);

it.effect("a connection base URL overrides the operation's servers", () =>
  Effect.promise(() =>
    withServer(async ({ baseUrl, requests }) => {
      const operation = OperationBinding.make({
        method: "get",
        servers: [
          ServerInfo.make({
            url: "https://unused.example",
            description: Option.none(),
            variables: Option.none(),
          }),
        ],
        pathTemplate: "/ping",
        requestBody: Option.none(),
        responseBody: Option.none(),
        parameters: [],
      });

      // The live server is the connection override; it wins over the spec server.
      await Effect.runPromise(
        invokeWithLayer(operation, {}, baseUrl, {}, {}, FetchHttpClient.layer),
      );

      expect(new URL(requests[0]!, "http://executor.test").pathname).toBe("/ping");
    }),
  ),
);

it.effect("falls back to the base URL for bindings persisted without servers", () =>
  Effect.promise(() =>
    withServer(async ({ baseUrl, requests }) => {
      // Old binding shape: no `servers` field at all.
      const operation = OperationBinding.make({
        method: "get",
        pathTemplate: "/ping",
        requestBody: Option.none(),
        responseBody: Option.none(),
        parameters: [],
      });

      await Effect.runPromise(
        invokeWithLayer(operation, {}, baseUrl, {}, {}, FetchHttpClient.layer),
      );

      expect(new URL(requests[0]!, "http://executor.test").pathname).toBe("/ping");
    }),
  ),
);
