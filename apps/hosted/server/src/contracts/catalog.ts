import type { Catalog } from "@executor-js/catalog/contracts";
import { Context } from "effect";

export class HostedCatalog extends Context.Service<HostedCatalog, Catalog>()(
  "executor/hosted/Catalog",
) {}

export const executorCatalogPackage = "executor";
