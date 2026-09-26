/** The catalog entry is cheap metadata; source generation loads the OpenAPI compiler on demand. */
import { CatalogEntry } from "@executor-js/catalog/contracts";

/** This installation's public API, available as an ordinary OpenAPI app. */
export const executorCatalogEntry = (origin: string) =>
  CatalogEntry.make({
    id: `${origin}/openapi.json`,
    kind: "openapi",
    name: "Executor",
    description: "Manage apps and connected accounts in Executor.",
    domain: new URL(origin).hostname,
    connectUrl: `${origin}/openapi.json`,
    oauthDiscoveryUrl: `${origin}/api`,
    feeds: ["curated"],
  });
