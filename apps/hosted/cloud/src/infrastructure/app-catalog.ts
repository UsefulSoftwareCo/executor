/**
 * The official app feed Add app lists (`notes/catalog-imports.md`). The executor-apps repository
 * builds it and publishes it into this bucket on every push to its `main`
 * (`.github/workflows/publish.yml` there); production owns the bucket and serves it read-only at
 * `catalog.executor.sh`. Every deployed stage reads that one feed.
 *
 * The bucket's hostname is an R2 custom domain. R2 custom domains use Cloudflare for SaaS
 * certificates, not the Advanced certificates Workers Custom Domains order, so it cannot replace
 * the certificate Cloudflare serves for the zone apex (`product-zone.ts`). Cloudflare owns its DNS
 * record.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import { Config, Effect, Option } from "effect";
import { customDomain, productZone } from "./stage.ts";

/** Where production serves the feed. */
export const appCatalogOrigin = `https://catalog.${productZone}`;

/** The publishing workflow names the bucket, so its name is fixed rather than generated. */
export const appCatalogBucketName = "executor-app-catalog";

/**
 * Production's feed bucket. The published content lives only here, so the bucket outlives a
 * removal from this stack. The API Worker reads the index and app sources; browsers on any
 * Executor origin, local and self-hosted ones included, load its icons, so any origin may read.
 */
export const AppCatalog = Effect.gen(function* () {
  const hostname = yield* customDomain(new URL(appCatalogOrigin));
  return yield* Cloudflare.R2.Bucket("AppCatalog", {
    name: appCatalogBucketName,
    domains: [{ name: hostname, zone: productZone, minTLS: "1.2" }],
    cors: [{ allowedMethods: ["GET", "HEAD"], allowedOrigins: ["*"], maxAgeSeconds: 86400 }],
  }).pipe(retain());
});

/**
 * The API Worker binding that lists the feed on a deployed stage. Test stages share production's
 * read-only feed rather than publishing their own.
 */
export const appCatalogBinding = Effect.gen(function* () {
  // A second, hand-set value would leave two bindings for one name.
  const configured = yield* Config.String("EXECUTOR_CATALOG_URL").pipe(Config.option);
  if (Option.isSome(configured))
    return yield* Effect.die(
      new Error(
        `Deployed stages read the feed at ${appCatalogOrigin}. ` +
          "Remove EXECUTOR_CATALOG_URL from the deploy environment.",
      ),
    );
  return { EXECUTOR_CATALOG_URL: `${appCatalogOrigin}/index.json` };
});
