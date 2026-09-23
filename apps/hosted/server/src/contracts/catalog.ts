/** Shared catalog capability; installation remains an authorized app operation. */
import type { Catalog } from "@executor-js/catalog/contracts";
import { Context } from "effect";

/** Catalog lookup supplied by the host; tests can supply an offline source. */
export class HostedCatalog extends Context.Service<HostedCatalog, Catalog>()(
  "executor/hosted/Catalog",
) {}
