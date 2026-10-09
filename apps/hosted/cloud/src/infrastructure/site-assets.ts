/** Every deploy's content-hashed browser files, kept in R2 for pages still running a replaced build. */
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

/** A copy expires `retainedAssetExpiryDays` after its last upload; nothing else deletes from it. */
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

/** The current build's static assets did not answer for a file its own list names. */
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

/**
 * One run checks at most this many files and copies at most `copiesPerRun`, each a few subrequests,
 * well inside Cloudflare's 10,000, and starts no more after `runMillis`. A whole build (about 250
 * files) fits in one run; a larger one, or a slow run, continues on the next.
 */
const checksPerRun = 1000;
const copiesPerRun = 500;
const runMillis = 20_000;
/** Files checked at once. */
const concurrency = 8;

const hour = 60 * 60 * 1000;

/**
 * How far a pass over one file list has got, kept on its marker: the files before `checked` are
 * stored, none uploaded before `oldest`.
 */
const PassProgress = Schema.Struct({
  checked: Schema.NumberFromString.check(Schema.isInt()),
  oldest: Schema.NumberFromString.check(Schema.isInt()),
});

/** Resolve the bucket during Worker initialization; the static assets are read per use. */
export const cloudSiteAssets = Effect.gen(function* () {
  const bucket = yield* Cloudflare.R2.ReadWriteBucket(SiteAssets);
  const environment = yield* Cloudflare.WorkerEnvironment;
  // The asset binding ignores the host; only the path selects a file.
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

  /** Store one file unless R2 holds a copy uploaded after `due`; answers the copy's upload time. */
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

  /**
   * Keep every file of the current build uploaded within about the last day, so R2 holds a file the
   * next deploy replaces for at least 30 days after it; see `retainedAssetExpiryDays`. A pass
   * checks the list's files in order and copies each one R2 lacks or last received over a day ago.
   * The list's marker records how far the pass has got and the oldest upload among the files it
   * checked, so a run continues an unfinished pass, and a finished pass holds until that oldest
   * upload is a day old. A file another build uploaded counts by its own upload time, never by when
   * this build's pass saw it.
   */
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
    // Only this job writes markers, always with their progress.
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

  /**
   * Answer a request under a retained folder. Only a miss in the static assets reaches the Worker
   * there, so this serves an earlier deploy's copy of a file the current build no longer has. A
   * file R2 does not hold either gets the same 404 as any other unmatched path.
   */
  const serve = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const key = yield* Effect.try(() =>
      decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice(1)),
    ).pipe(Effect.option);
    // Only a name the copy job could have stored is looked up.
    if (Option.isNone(key) || !retainedAssetPath.test(key.value)) {
      yield* Effect.annotateCurrentSpan("executor.asset.retained", "invalid");
      return yield* notFoundDocument;
    }
    const object = yield* bucket.get(key.value).pipe(Effect.provide(RuntimeContext.phantom));
    yield* Effect.annotateCurrentSpan("executor.asset.retained", object === null ? "miss" : "hit");
    if (object === null) return yield* notFoundDocument;
    const contentType = object.httpMetadata?.contentType;
    // The copy job stores every file with its content type; a copy without one was not written by it.
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
