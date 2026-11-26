import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
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

        const list = yield* get("/retained-assets.json").pipe(
          Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(RetainedList)(body)),
        );
        for (const folder of ["assets/", "_astro/", "docs/_astro/"])
          expect(
            list.files.some((file) => file.startsWith(folder)),
            folder,
          ).toBe(true);

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

        const module = yield* get("/assets/groups-00000000.js");
        const docs = yield* get("/docs/_astro/missing.00000000.js");
        const navigation = yield* get("/_astro/missing.00000000.js", "text/html");
        yield* evidence.json("missing.json", { module, docs, navigation: navigation.status });
        expect(module).toEqual({ status: 404, type: "", body: "" });
        expect(docs).toEqual({ status: 404, type: "", body: "" });
        expect(navigation.status).toBe(404);
        expect(navigation.type).toContain("text/html");
        const unhashed = yield* get("/assets/groups.js");
        const escaping = yield* get("/assets/%2E%2E%2Fretained-assets.json");
        expect(unhashed).toEqual({ status: 404, type: "", body: "" });
        expect(escaping).toEqual({ status: 404, type: "", body: "" });
      }),
    ),
  );
});
