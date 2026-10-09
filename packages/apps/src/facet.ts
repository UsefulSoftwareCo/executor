/** The data facet's storage capability; used only by the generated data facet, never browser bundles. */
import type { AppSqlStorage } from "./contracts/sql.ts";

/** Bind one facet's storage at the runtime edge. App code receives `ctx.sql` over it, never the storage. */
export const facetStorage = (storage: AppSqlStorage): AppSqlStorage => storage;
