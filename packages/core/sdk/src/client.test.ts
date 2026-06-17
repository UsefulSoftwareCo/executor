// Regression coverage for `createPluginAtomClient`. The change that
// triggered this test is dropping the explicit `pluginId` option in
// favour of reading `group.identifier`. The properties under test are:
//
//   1. The synthetic `AtomHttpApi.Service` Tag's `.key` is
//      `Plugin_<groupId>Client` — a non-empty Tag id is what makes
//      caching/invalidation work (atoms are deduped per Tag identity;
//      reactivity invalidations are routed by Tag).
//   2. Two clients built from groups with different identifiers get
//      distinct Tag keys — so plugins coexist in one React tree
//      without sharing atom state across plugin boundaries.
//   3. `.query` / `.mutation` return Atom-shaped descriptors —
//      confirms the wrapper still composes the per-plugin `HttpApi`
//      bundle correctly so AtomHttpApi can build the client.
//
// React Testing Library is intentionally not used here. The change
// affected the Tag-derivation path inside `createPluginAtomClient`,
// not the React side of `@effect/atom-react`. Verifying the Tag
// identity + atom shape is what catches a regression in the area we
// modified; mounting components would test `@effect/atom-react`,
// which we did not touch.

import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { applyPluginAtomClientRequestTransform, createPluginAtomClient } from "./client";

const FooGroup = HttpApiGroup.make("foo").add(
  HttpApiEndpoint.get("ping", "/ping", { success: Schema.String }),
);

const BarGroup = HttpApiGroup.make("bar").add(
  HttpApiEndpoint.post("set", "/set", {
    payload: Schema.Struct({ value: Schema.String }),
    success: Schema.String,
  }),
);

describe("createPluginAtomClient", () => {
  it("derives the Service Tag id from group.identifier", () => {
    const FooClient = createPluginAtomClient(FooGroup);
    expect(FooClient.key).toBe("Plugin_fooClient");
  });

  it("produces non-colliding Tag ids for groups with different identifiers", () => {
    const A = createPluginAtomClient(FooGroup);
    const B = createPluginAtomClient(BarGroup);
    expect(A.key).not.toBe(B.key);
    expect(A.key).toBe("Plugin_fooClient");
    expect(B.key).toBe("Plugin_barClient");
  });

  it("returns Atom descriptors from `.query` and `.mutation`", () => {
    const FooClient = createPluginAtomClient(FooGroup);
    const BarClient = createPluginAtomClient(BarGroup);

    const ping = FooClient.query("foo", "ping", {});
    const set = BarClient.mutation("bar", "set");

    // Atoms are reachable values — the exact shape is internal to
    // `@effect-atom/atom`. A regression in pluginId derivation would
    // typically surface as a missing-Tag throw inside the runtime
    // before these factories returned anything.
    expect(ping).toBeTruthy();
    expect(set).toBeTruthy();
  });

  it("can apply dynamic server connection URL and auth to plugin requests", () => {
    const request = HttpClientRequest.get("/graphql/sources");
    const transformed = applyPluginAtomClientRequestTransform(request, {
      baseUrl: () => "https://executor.example/api",
      authorizationHeader: () => "Bearer key_123",
    });

    expect(transformed.url).toBe("https://executor.example/api/graphql/sources");
    expect(transformed.headers.authorization).toBe("Bearer key_123");
  });

  it("can apply host-supplied dynamic request headers to plugin requests", () => {
    const request = HttpClientRequest.get("/openapi/integrations/acme");
    const transformed = applyPluginAtomClientRequestTransform(request, {
      headers: () => ({
        "x-executor-organization": "newvale",
        "x-empty": null,
      }),
    });

    expect(transformed.headers["x-executor-organization"]).toBe("newvale");
    expect(transformed.headers["x-empty"]).toBeUndefined();
  });
});
