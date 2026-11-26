import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import { Config, Effect, Option } from "effect";
import { customDomain, productZone } from "./stage.ts";

export const appCatalogOrigin = `https://catalog.${productZone}`;

export const appCatalogBucketName = "executor-app-catalog";

export const AppCatalog = Effect.gen(function* () {
  const hostname = yield* customDomain(new URL(appCatalogOrigin));
  return yield* Cloudflare.R2.Bucket("AppCatalog", {
    name: appCatalogBucketName,
    domains: [{ name: hostname, zone: productZone, minTLS: "1.2" }],
    cors: [{ allowedMethods: ["GET", "HEAD"], allowedOrigins: ["*"], maxAgeSeconds: 86400 }],
  }).pipe(retain());
});

export const appCatalogBinding = Effect.gen(function* () {
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
