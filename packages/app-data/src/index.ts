/** Portable, app-owned database engine and contracts. */
export * from "./contracts/database.ts";
export { makeSqliteDatabase } from "./implementation/sqlite.ts";

export {
  promiseTable,
  type IndexRange,
  type Query,
  type ReadTable,
  type WriteTable,
} from "./implementation/promise.ts";
