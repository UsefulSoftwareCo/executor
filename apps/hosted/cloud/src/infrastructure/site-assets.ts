import type { Fetcher } from "@cloudflare/workers-types";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import { Clock, Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  RetainedAssetList,
  retainedAssetCacheControl,
  retainedAssetExpiryDays,
  retainedAssetList,
  retainedAssetPath,
  retainedAssetRefreshHours,
} from "../contracts/retained-assets.ts";
import { notFoundDocument } from "../implementation/not-found.ts";
import { testStage } from "./stage.ts";

export const SiteAssets = Cloudflare.R2.Bucket(
  "SiteAssets",
  testStage.pipe(
    Effect.map((stage) => ({
      forceDestroy: Option.isSome(stage),
      lifecycleRules: [
        {
          id: "expire-replaced-builds",
          deleteObjectsTransition: {
            condition: { type: "Age" as const, maxAge: retainedAssetExpiryDays * 24 * 60 * 60 },
          },
        },
      ],
    })),
    Effect.orDie,
  ),
).pipe(retain(testStage.pipe(Effect.map(Option.isNone), Effect.orDie)));

export class SiteAssetsUnavailable extends Schema.TaggedError<SiteAssetsUnavailable>()(
  "SiteAssetsUnavailable",
  { path: Schema.String, status: Schema.optionalKey(Schema.Number) },
) {}

const StaticAssets = Schema.declare(
  (value): value is Pick<Fetcher, "fetch"> =>
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function",
);

const checksPerRun = 1000;
const copiesPerRun = 500;
const runMillis = 20_000;
const concurrency = 8;

const hour = 60 * 60 * 1000;

const PassProgress = Schema.Struct({
  checked: Schema.NumberFromString.check(Schema.isInt()),
  oldest: Schema.NumberFromString.check(Schema.isInt()),
});

export const cloudSiteAssets = Effect.gen(function* () {
  const bucket = yield* Cloudflare.R2.ReadWriteBucket(SiteAssets);
  const environment = yield* Cloudflare.WorkerEnvironment;
  const asset = (path: string) =>
    Schema.decodeUnknownEffect(StaticAssets)(environment.ASSETS).pipe(
      Effect.orDie,
      Effect.flatMap((assets) =>
        Effect.tryPromise({
          try: () => assets.fetch(new URL(path, "https://assets.invalid").href),
          catch: () => new SiteAssetsUnavailable({ path }),
        }),
      ),
      Effect.flatMap((response) =>
        response.ok
          ? Effect.succeed(response)
          : Effect.fail(new SiteAssetsUnavailable({ path, status: response.status })),
      ),
    );

  const retainFile = (file: string, due: number) =>
    Effect.gen(function* () {
      const stored = yield* bucket.head(file);
      if (stored !== null && stored.uploaded.getTime() > due)
        return { uploaded: stored.uploaded.getTime(), copied: false };
      const response = yield* asset(`/${file}`);
      const contentType = response.headers.get("content-type");
      if (contentType === null)
        return yield* new SiteAssetsUnavailable({ path: `/${file}`, status: response.status });
      const body = yield* Effect.tryPromise({
        try: () => response.arrayBuffer(),
        catch: () => new SiteAssetsUnavailable({ path: `/${file}` }),
      });
      const written = yield* bucket.put(file, body, {
        httpMetadata: { contentType, cacheControl: retainedAssetCacheControl },
      });
      return { uploaded: written.uploaded.getTime(), copied: true };
    });

  const retainCurrent = Effect.gen(function* () {
    const list = yield* asset(retainedAssetList).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.text(),
          catch: () => new SiteAssetsUnavailable({ path: retainedAssetList }),
        }),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RetainedAssetList))),
    );
    const started = yield* Clock.currentTimeMillis;
    const due = started - retainedAssetRefreshHours * hour;
    const marker = `builds/${list.build}`;
    const stored = yield* bucket.head(marker);
    const progress =
      stored === null
        ? undefined
        : yield* Schema.decodeUnknownEffect(PassProgress)(stored.customMetadata).pipe(Effect.orDie);
    const finished = progress !== undefined && progress.checked === list.files.length;
    if (finished && progress.oldest > due)
      return yield* Effect.annotateCurrentSpan("executor.assets.retained.outcome", "unchanged");
    const from = progress === undefined || finished ? 0 : progress.checked;
    let checked = from;
    let oldest = progress === undefined || finished ? started : progress.oldest;
    let copied = 0;
    while (
      checked < list.files.length &&
      checked - from < checksPerRun &&
      copied < copiesPerRun &&
      (yield* Clock.currentTimeMillis) - started < runMillis
    ) {
      const files = list.files.slice(checked, checked + concurrency);
      const retained = yield* Effect.forEach(files, (file) => retainFile(file, due), {
        concurrency,
      });
      for (const file of retained) {
        oldest = Math.min(oldest, file.uploaded);
        if (file.copied) copied++;
      }
      checked += files.length;
    }
    yield* bucket.put(marker, list.build, {
      customMetadata: { checked: String(checked), oldest: String(oldest) },
    });
    yield* Effect.annotateCurrentSpan({
      "executor.assets.retained.outcome": checked === list.files.length ? "complete" : "partial",
      "executor.assets.retained.files": list.files.length,
      "executor.assets.retained.checked": checked - from,
      "executor.assets.retained.copied": copied,
    });
  }).pipe(Effect.provide(RuntimeContext.phantom), Effect.withSpan("job.site-assets.retain"));

  const serve = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const key = yield* Effect.try(() =>
      decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice(1)),
    ).pipe(Effect.option);
    if (Option.isNone(key) || !retainedAssetPath.test(key.value)) {
      yield* Effect.annotateCurrentSpan("executor.asset.retained", "invalid");
      return yield* notFoundDocument;
    }
    const object = yield* bucket.get(key.value).pipe(Effect.provide(RuntimeContext.phantom));
    yield* Effect.annotateCurrentSpan("executor.asset.retained", object === null ? "miss" : "hit");
    if (object === null) return yield* notFoundDocument;
    const contentType = object.httpMetadata?.contentType;
    if (contentType === undefined)
      return yield* Effect.die(new Error(`Retained asset ${key.value} has no content type`));
    return HttpServerResponse.stream(object.body, {
      contentType,
      contentLength: object.size,
      headers: { "cache-control": retainedAssetCacheControl, etag: object.httpEtag },
    });
  }).pipe(Effect.withSpan("runtime.cloud.asset.retained"));

  return { retainCurrent, serve };
}).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding));
