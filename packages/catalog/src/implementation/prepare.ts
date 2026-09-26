/** Generate app source for a catalog choice. Loaded when a user prepares an app, not at startup. */
import { Effect } from "effect";
import { CatalogImportFailed, quickAdd, type Catalog } from "../contracts/catalog.ts";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { catalogStage } from "./diagnostics.ts";
import { generateCustomApp } from "./custom.ts";
import { generateMcpApp } from "./mcp.ts";

export { generateCustomApp };

/** Resolve one listed entry into ordinary app source, or ask for agent setup. */
export const prepareEntry = (
  list: Catalog["list"],
  egress: HostEgress,
  input: Parameters<Catalog["prepare"]>[0],
) =>
  Effect.gen(function* () {
    const entry = (yield* list).find((entry) => entry.id === input.entry);
    if (entry === undefined)
      return yield* new CatalogImportFailed({
        code: "entry_missing",
        reason: "This entry is no longer in the catalog. Refresh and choose another app.",
      });
    // Only a matched public catalog identifier is recorded, never an arbitrary lookup input.
    yield* Effect.annotateCurrentSpan({
      "catalog.entry.id": entry.id,
      "catalog.entry.kind": entry.kind,
    });
    if (entry.kind !== "mcp" || !quickAdd(entry))
      return yield* new CatalogImportFailed({
        code: "agent_setup_required",
        reason:
          "Set up this service with your agent. Copy the setup prompt and send it to your agent.",
      });
    return yield* generateMcpApp(
      { name: entry.name, url: entry.connectUrl, oauthDiscoveryUrl: entry.oauthDiscoveryUrl },
      egress,
    ).pipe(catalogStage("mcp"));
  });
