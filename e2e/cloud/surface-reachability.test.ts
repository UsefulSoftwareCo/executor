// Cloud-only: every mounted /api plane ANSWERS — nothing silently falls
// through to the SPA's 200-HTML fallback (the billing-404 regression class).
// Docs and the spec are served, the billing proxy and the protected API gate
// reject anonymous callers with their own structured JSON, and unknown /api
// paths are a real 404. All raw fetch: this is about raw wire dispatch.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Api, Billing, Target } from "../src/services";

scenario(
  "Surfaces · Swagger UI and the OpenAPI spec document the mounted API",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;
    const docs = yield* Effect.promise(() => fetch(new URL("/api/docs", target.baseUrl)));
    expect(docs.status, "Swagger UI is served").toBe(200);
    expect(docs.headers.get("content-type"), "as an HTML page").toContain("text/html");
    const docsHtml = yield* Effect.promise(() => docs.text());
    expect(docsHtml.toLowerCase(), "it is the Swagger UI shell").toContain("swagger");

    const spec = yield* Effect.promise(() => fetch(new URL("/api/openapi.json", target.baseUrl)));
    expect(spec.status, "the OpenAPI spec is served").toBe(200);
    expect(spec.headers.get("content-type"), "as JSON").toContain("application/json");
    const parsed = (yield* Effect.promise(() => spec.json())) as {
      paths?: Record<string, unknown>;
    };
    const paths = Object.keys(parsed.paths ?? {});
    expect(paths, "the core protected API is documented").toContain("/api/integrations");
    expect(paths, "the session-auth plane is documented").toContain("/api/auth/me");
    expect(paths, "the org plane is documented").toContain("/api/org/domains");
    expect(paths, "path-param routes are documented").toContain(
      "/api/executions/{executionId}/resume",
    );
  }),
);

scenario(
  "Surfaces · the billing proxy answers with its own 401 JSON, not the SPA fallback",
  {},
  Effect.gen(function* () {
    // Gates: the REST API plane is mounted and billing is enforced here.
    yield* Api;
    yield* Billing;
    const target = yield* Target;
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/billing/customer", target.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    // The regression returned the SPA fallback (200 text/html). The real
    // billing route is reached and rejects the unauthenticated call itself.
    expect(response.status, "the billing route rejects the anonymous call").toBe(401);
    expect(response.headers.get("content-type"), "with a JSON body").toContain("application/json");
    const body = yield* Effect.promise(() => response.json());
    expect(body, "the structured refusal a client can act on").toEqual({
      error: "Unauthorized",
      code: "unauthorized",
    });
  }),
);

scenario(
  "Surfaces · every protected plane refuses anonymous callers with structured JSON",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;
    // The core protected API: anonymous callers hit the auth gate, which
    // answers in JSON (never the SPA) with the documented refusal body.
    const core = yield* Effect.promise(() => fetch(new URL("/api/integrations", target.baseUrl)));
    expect(core.status, "no credentials → no organization to act in").toBe(403);
    expect(core.headers.get("content-type"), "the gate answers in JSON").toContain(
      "application/json",
    );
    expect(yield* Effect.promise(() => core.json()), "the documented refusal body").toEqual({
      error: "No organization in session",
      code: "no_organization",
    });

    // The session-auth plane is mounted and gated.
    const sessionMe = yield* Effect.promise(() => fetch(new URL("/api/auth/me", target.baseUrl)));
    expect(sessionMe.status, "the session API requires a session").toBe(401);

    // The org plane is mounted and gated.
    const orgDomains = yield* Effect.promise(() =>
      fetch(new URL("/api/org/domains", target.baseUrl)),
    );
    expect(orgDomains.status, "the org API requires a session").toBe(401);
  }),
);

scenario(
  "Surfaces · unknown /api routes are a real 404, not the SPA fallback",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/this-route-does-not-exist", target.baseUrl)),
    );
    expect(response.status, "the API plane owns its 404s").toBe(404);
    const body = yield* Effect.promise(() => response.text());
    expect(body, "no SPA HTML leaks out of the API plane").not.toContain("<!DOCTYPE html");
  }),
);
