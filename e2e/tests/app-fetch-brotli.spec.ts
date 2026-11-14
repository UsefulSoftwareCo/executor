/**
 * The app runtime never decodes a Brotli response. workerd's bundled Brotli decoder has
 * CVE-2026-111497, an out-of-bounds write a crafted stream can turn into code execution, so every
 * Worker sets `no_brotli_content_encoding` and a service's `Content-Encoding: br` body reaches app
 * code as the bytes the service sent, through the platform's `fetch` and the framework's
 * `ctx.fetch` alike.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { brotliBody, egressUpstream } from "../support/egress-upstream.ts";

const Received = Schema.Struct({
  status: Schema.Number,
  encoding: Schema.NullOr(Schema.String),
  hex: Schema.String,
});

const fetchApp = `import { defineApp, object, string, query, router } from "apps";
const received = async (response) => ({
  status: response.status,
  encoding: response.headers.get("content-encoding"),
  hex: Array.from(new Uint8Array(await response.arrayBuffer()), (byte) => byte.toString(16).padStart(2, "0")).join(""),
});
const input = { input: object({ url: string() }) };
export default defineApp({}, {
  tools: router({
    global: query(input, async (_ctx, { url }) => received(await fetch(url))),
    fetched: query(input, async (ctx, { url }) => received(await ctx.fetch(url))),
  }),
});`;

layer(HostedLive, { excludeTestServices: true })("App fetch Brotli", (it) => {
  it.effect(scenarios.appFetchBrotliUndecoded.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const upstream = yield* egressUpstream;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Fetch Brotli ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: fetchApp }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );

        const sent = { status: 200, encoding: "br", hex: brotliBody.toString("hex") };
        for (const tool of ["global", "fetched"]) {
          const response = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/${app.id}/tools/call`,
            { tool, kind: "query", input: { url: `${upstream.origin}/brotli` } },
          );
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(yield* body(Received, response), tool).toEqual(sent);
        }
      }),
    ),
  );
});
