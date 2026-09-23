/** Native Effect PGlite client with FumaDB's UTC temporal contract. */
import { PgliteClient } from "@effect/sql-pglite";

/**
 * Keep naive timestamp/date values as text so the FumaDB codec decodes them as UTC.
 * PGlite otherwise creates Date objects in the machine timezone before the codec runs.
 * The native Effect layer owns serialization, transactions, and closing the database.
 */
export const pgliteLayer = (
  options: Omit<PgliteClient.PgliteClientConfig.Create, "parsers"> = {},
) =>
  PgliteClient.layer({ ...options, parsers: { 1082: (value) => value, 1114: (value) => value } });
