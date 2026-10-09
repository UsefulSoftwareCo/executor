/**
 * Cloud keeps every deploy's content-hashed browser files in R2, so a page still running a replaced
 * build can load the files it has not loaded yet. The Worker's minute job copies the live build's
 * listed files; a later run finds them all stored. A file no build kept still gets the ordinary
 * 404 through the Worker's retained-file routes: empty for a module, the 404 page for a navigation.
 * A name the job could not have stored is refused without an R2 lookup.
 *
 * Serving an earlier build's file needs a real deploy: the local Worker's static assets list their
 * files once at startup, so a file removed from disk is a server error there, not a miss. That
 * journey was verified on a test stage (see the pull request that added this scenario).
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";

const RetainedList = Schema.fromJsonString(
  Schema.Struct({ build: Schema.String, files: Schema.Array(Schema.String) }),
);

layer(HostedLive, { excludeTestServices: true })("Retained build assets", (it) => {
  it.effect(scenarios.retainedAssets.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence,
          target = yield* Target,
          telemetry = yield* Telemetry,
          http = yield* HttpClient.HttpClient;
        expect(target.metadata.mode).toBe("managed");
        const origin = target.metadata.origin;
        const get = (path: string, accept?: string) =>
          Effect.scoped(
            http
              .execute(
                accept === undefined
                  ? HttpClientRequest.get(`${origin}${path}`)
                  : HttpClientRequest.get(`${origin}${path}`).pipe(
                      HttpClientRequest.accept(accept),
                    ),
              )
              .pipe(
                Effect.flatMap((response) =>
                  response.text.pipe(
                    Effect.map((body) => ({
                      status: response.status,
                      type: response.headers["content-type"] ?? "",
                      body,
                    })),
                  ),
                ),
              ),
          );

        // The site build lists the dashboard, marketing and documentation files every deploy keeps.
        const list = yield* get("/retained-assets.json").pipe(
          Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(RetainedList)(body)),
        );
        for (const folder of ["assets/", "_astro/", "docs/_astro/"])
          expect(
            list.files.some((file) => file.startsWith(folder)),
            folder,
          ).toBe(true);

        // Every listed name is content-hashed, so the static assets serve each folder's files for a
        // browser to keep without revalidating.
        for (const folder of ["assets/", "_astro/", "docs/_astro/"]) {
          const file = list.files.find((listed) => listed.startsWith(folder));
          expect(file, folder).toBeDefined();
          const served = yield* Effect.scoped(
            http.get(`${origin}/${file}`).pipe(
              Effect.tap((response) => response.text),
              Effect.map((response) => ({
                status: response.status,
                cacheControl: response.headers["cache-control"],
              })),
            ),
          );
          yield* evidence.json(`cache-${folder.slice(0, -1).replaceAll("/", "-")}.json`, {
            file,
            ...served,
          });
          expect(served, folder).toEqual({
            status: 200,
            cacheControl: "public, max-age=31536000, immutable",
          });
        }

        // Run the minute jobs until a copy finds every listed file already in R2.
        const tick = Effect.scoped(
          http
            .get(`${origin}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`)
            .pipe(Effect.flatMap((response) => response.text)),
        );
        const unchanged = yield* tick.pipe(
          Effect.andThen(
            telemetry.search("job.site-assets.retain", {
              "executor.assets.retained.outcome": "unchanged",
            }),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (found) => found.data.length > 0,
            times: 20,
          }),
        );
        expect(unchanged.data.length).toBeGreaterThan(0);
        // R2 started empty, so the runs before it copied every listed file. A pass can span runs,
        // and a run that overlapped another copies what was still missing, so only the total counts.
        const copied = (outcome: string) =>
          telemetry
            .search("job.site-assets.retain", { "executor.assets.retained.outcome": outcome })
            .pipe(
              Effect.map((found) =>
                found.data.reduce(
                  (total, { span }) =>
                    total + Number(span.tags["executor.assets.retained.copied"] ?? 0),
                  0,
                ),
              ),
            );
        const total = (yield* copied("complete")) + (yield* copied("partial"));
        expect(total).toBeGreaterThanOrEqual(list.files.length);

        // A file no build kept misses the static assets and R2, and gets the ordinary 404.
        const module = yield* get("/assets/groups-00000000.js");
        const docs = yield* get("/docs/_astro/missing.00000000.js");
        const navigation = yield* get("/_astro/missing.00000000.js", "text/html");
        yield* evidence.json("missing.json", { module, docs, navigation: navigation.status });
        expect(module).toEqual({ status: 404, type: "", body: "" });
        expect(docs).toEqual({ status: 404, type: "", body: "" });
        expect(navigation.status).toBe(404);
        expect(navigation.type).toContain("text/html");
        // Each of those requests went through the retained-file route and found no copy.
        const misses = yield* telemetry
          .search("runtime.cloud.asset.retained", { "executor.asset.retained": "miss" })
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (found) => found.data.length >= 3,
              times: 20,
            }),
          );
        expect(misses.data.length).toBeGreaterThanOrEqual(3);

        // A name without a content hash, or one that leaves its folder, is refused before R2.
        const unhashed = yield* get("/assets/groups.js");
        const escaping = yield* get("/assets/%2E%2E%2Fretained-assets.json");
        expect(unhashed).toEqual({ status: 404, type: "", body: "" });
        expect(escaping).toEqual({ status: 404, type: "", body: "" });
        const refused = yield* telemetry
          .search("runtime.cloud.asset.retained", { "executor.asset.retained": "invalid" })
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (found) => found.data.length >= 2,
              times: 20,
            }),
          );
        expect(refused.data.length).toBeGreaterThanOrEqual(2);
      }),
    ),
  );
});
