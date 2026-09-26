/** The catalog entry is cheap metadata; the app source loads on demand. */
import { CatalogEntry } from "@executor-js/catalog/contracts";

/** This installation's public API, available as a built-in app. */
export const executorCatalogEntry = (origin: string) =>
  CatalogEntry.make({
    id: `${origin}/openapi.json`,
    kind: "app",
    name: "Executor",
    description: "Manage apps and connected accounts in Executor.",
    domain: new URL(origin).hostname,
    connectUrl: `${origin}/openapi.json`,
    oauthDiscoveryUrl: `${origin}/api`,
    feeds: ["curated"],
  });
