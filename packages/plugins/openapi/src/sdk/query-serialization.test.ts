import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { createServer, type Server } from "node:http";

import { invokeWithLayer } from "./invoke";
import { OperationBinding, OperationParameter } from "./types";

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
        pathTemplate: "/messages/{id}",
        requestBody: Option.none(),
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
        baseUrl,
        pathTemplate: "/v1/{+name}",
        requestBody: Option.none(),
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
          "https://unused.example",
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
