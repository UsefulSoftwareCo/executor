import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultUrlPolicy } from "@executor-js/utils/url-policy";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { bearerResourceMetadata } from "../src/implementation/oauth-challenge.ts";
import { makeOAuthProtocol } from "../src/implementation/oauth-protocol.ts";

test("resource metadata belongs to a Bearer challenge, including mixed challenges and quoted commas", () => {
  const url = "https://metadata.example/resource";
  assert.equal(bearerResourceMetadata(`Bearer resource_metadata="${url}"`), url);
  assert.equal(
    bearerResourceMetadata(
      `Basic realm="a,b", bEaReR realm="service", RESOURCE_METADATA = "${url}"`,
    ),
    url,
  );
  assert.equal(bearerResourceMetadata(`Bearer resource_metadata=${url}`), url);
  assert.equal(bearerResourceMetadata(`Basic resource_metadata="${url}"`), undefined);
  assert.equal(bearerResourceMetadata(`Bearer token68, resource_metadata="${url}"`), undefined);
  assert.equal(
    bearerResourceMetadata(
      `Bearer resource_metadata="${url}", resource_metadata="https://other.example"`,
    ),
    undefined,
  );
  assert.equal(bearerResourceMetadata(`Bearer resource_metadata="${url}`), undefined);
});

for (const invalid of [
  "https://unrelated.example",
  "https://service.example/other",
  "https://service.example/mc",
  "http://service.example",
  "https://user:password@service.example",
]) {
  test(`discovery rejects an unrelated or unsafe resource: ${new URL(invalid).hostname}`, async () => {
    let requests = 0;
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        requests++;
        return HttpClientResponse.fromWeb(
          request,
          requests === 1
            ? new Response(null, {
                status: 401,
                headers: {
                  "www-authenticate":
                    'Bearer resource_metadata="https://metadata.example/resource"',
                },
              })
            : Response.json({
                resource: invalid,
                authorization_servers: ["https://issuer.example"],
              }),
        );
      }),
    );
    const protocol = makeOAuthProtocol({
      httpClient,
      clientName: "Fixture",
      urlPolicy: defaultUrlPolicy,
    });
    await assert.rejects(
      () =>
        Effect.runPromise(
          protocol.discover({
            type: "oauth2",
            discover: "https://service.example/mcp",
            response: {},
          }),
        ),
      { _tag: "OAuthProtocolFailed", reason: "invalid_response" },
    );
    assert.equal(requests, 2);
  });
}
