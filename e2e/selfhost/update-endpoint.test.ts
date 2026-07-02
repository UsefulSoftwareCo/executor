// Selfhost-only (runs on the dev server AND the production Docker image): the
// update check's `/v1/app/npm/dist-tags` must reach the Effect route and answer
// JSON, not get swallowed by the SPA index.html fallback. That fallback is
// exactly the failure mode that kept the sidebar UpdateCard dark before this
// route existed (a 200-with-HTML response fails the client's JSON parse), so
// asserting the content-type is JSON is the real contract. The body is the live
// dist-tags (possibly empty when the registry is unreachable) — reachability,
// not contents, is what this pins per host.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Target } from "../src/services";

scenario(
  "Selfhost · the update dist-tags endpoint answers JSON, not the SPA fallback",
  { timeout: 60_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const res = yield* Effect.promise(() => fetch(`${target.baseUrl}/v1/app/npm/dist-tags`));
    expect(res.status, "the endpoint responds 200").toBe(200);
    expect(
      res.headers.get("content-type") ?? "",
      "served as JSON by the Effect route, not the SPA index.html",
    ).toContain("application/json");
    const body = (yield* Effect.promise(() => res.json())) as Record<string, unknown>;
    expect(typeof body, "the body is a JSON object of dist-tags").toBe("object");
  }),
);
