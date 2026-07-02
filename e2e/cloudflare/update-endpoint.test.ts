// Cloudflare-only: the update check's `/v1/app/npm/dist-tags` must reach the
// Worker and answer JSON. On Cloudflare the SPA is served by Workers Static
// Assets, which return index.html for any path NOT in `run_worker_first`
// (wrangler.jsonc) — so without `/v1/*` listed there, this path 200s with HTML
// and the client's JSON parse fails (the sidebar UpdateCard stays dark). This
// pins that the asset layer forwards `/v1/*` to the Worker. The body is the live
// dist-tags (possibly empty); reachability is the contract here.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Target } from "../src/services";

scenario(
  "Cloudflare · the update dist-tags endpoint answers JSON, not the SPA fallback",
  { timeout: 60_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const res = yield* Effect.promise(() => fetch(`${target.baseUrl}/v1/app/npm/dist-tags`));
    expect(res.status, "the endpoint responds 200").toBe(200);
    expect(
      res.headers.get("content-type") ?? "",
      "forwarded to the Worker (run_worker_first), not the SPA index.html",
    ).toContain("application/json");
    const body = (yield* Effect.promise(() => res.json())) as Record<string, unknown>;
    expect(typeof body, "the body is a JSON object of dist-tags").toBe("object");
  }),
);
