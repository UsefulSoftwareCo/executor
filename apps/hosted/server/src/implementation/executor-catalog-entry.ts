/** The catalog entry is cheap metadata; the app source loads on demand. */
import { CatalogEntry } from "@executor-js/catalog/contracts";

/** This installation's public API, available as a built-in app. */
export const executorCatalogEntry = (origin: string) =>
  CatalogEntry.make({
    id: `${origin}/openapi.json`,
    package: "executor",
    name: "Executor",
    description: "Manage apps and connected accounts in Executor.",
    auth: [
      { method: "oauth", kind: "oauth2" },
      { method: "apiKey", kind: "secrets", label: "Executor API key" },
    ],
    icons: [{ src: "/favicon.png", mimeType: "image/png" }],
  });
