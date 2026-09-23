import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { CompanyLookup } from "../src/contracts/onboarding.ts";
import { companyLookupLive } from "../src/implementation/company-profile.ts";

const lookup = (status: number, response: unknown) =>
  Effect.runPromise(
    Effect.exit(
      Effect.flatMap(CompanyLookup, (company) => company.lookup("example.com")).pipe(
        Effect.provide(companyLookupLive(Redacted.make("synthetic-key"))),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(response), {
                  status,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

test("company lookup selects a safe icon and parses public company fields", async () => {
  const result = await lookup(200, {
    brand: {
      domain: "example.com",
      title: " Example Company ",
      description: "Example description",
      logos: [
        { type: "icon", url: "javascript:alert(1)" },
        { type: "logo", url: "https://example.com/wordmark.svg" },
        { type: "icon", url: "https://example.com/icon.svg" },
      ],
      colors: [{ hex: "#123456" }],
    },
  });
  assert.ok(Exit.isSuccess(result));
  assert.deepEqual(result.value, {
    name: "Example Company",
    website: "https://example.com",
    description: "Example description",
    logo: "https://example.com/icon.svg",
    colors: ["#123456"],
  });
});

test("personal addresses and unmatched domains are distinct from retryable provider failures", async () => {
  for (const status of [404, 422]) {
    const result = await lookup(status, {});
    assert.ok(Exit.isSuccess(result));
    assert.equal(result.value, null);
  }
  for (const [status, body] of [
    [503, {}],
    [429, {}],
    [200, { partial: true }],
    [200, { partial: true, brand: { domain: "example.com", title: "Example" } }],
    [200, { brand: { title: 42 } }],
  ] as const)
    assert.ok(Exit.isFailure(await lookup(status, body)));
});
