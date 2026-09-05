import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { dump } from "js-yaml";

import { previewSpecText, previewSpecTextStreaming } from "./preview";

const readOperation = {
  operationId: "getAccount",
  parameters: [
    {
      name: "RPC-Version",
      in: "header",
      required: true,
      schema: { type: "string" },
    },
  ],
  responses: { "200": { description: "OK" } },
};

describe("health-check operations", () => {
  it.effect("keeps body requirements and POST risk visible in both preview paths", () =>
    Effect.gen(function* () {
      for (const required of [true, false]) {
        const specText = dump({
          openapi: "3.0.3",
          info: { title: "Account RPC API", version: "1" },
          servers: [{ url: "https://api.example.test" }],
          paths: {
            "/rpc/getAccount": {
              post: {
                ...readOperation,
                requestBody: {
                  required,
                  content: { "application/json": { schema: { type: "object" } } },
                },
              },
            },
            "/me": {
              get: {
                operationId: "getMe",
                responses: { "200": { description: "OK" } },
              },
            },
          },
        });
        const whole = yield* previewSpecText(specText);
        const streamed = yield* previewSpecTextStreaming(specText);
        expect(streamed.healthCheckCandidates).toEqual(whole.healthCheckCandidates);
        expect(whole.healthCheckCandidates[0]?.method).toBe("get");
        expect(
          whole.healthCheckCandidates.find((candidate) => candidate.method === "post"),
        ).toMatchObject({
          destructive: true,
          requiredArgCount: required ? 2 : 1,
          parameters: [
            { name: "RPC-Version", location: "header", required: true },
            { name: "body", location: "body", required },
          ],
        });
      }
    }),
  );
});
