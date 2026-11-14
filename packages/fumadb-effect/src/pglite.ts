/** Optional embedded Postgres adapter. Importing it does not open a database. */
export {
  createPgliteDatabase,
  pgliteLayer,
  persistentPgliteLayer,
} from "./implementation/pglite.ts";
export { PgliteCreationFailed } from "./contracts/errors.ts";
