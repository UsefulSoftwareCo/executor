/**
 * Snapshot formatting that matches upstream fumadb's `inspect(value, { depth: null, sorted: true })`.
 */
import { inspect } from "node:util";

export const show = (value: unknown): string => inspect(value, { depth: null, sorted: true });

/**
 * Upstream snapshots embed the full `name-variants` JSON, which listed drizzle /
 * prisma / convex / mongodb names this package does not have. Strip that payload
 * from both sides before comparing.
 */
export const normalizeMigrationSql = (sql: string): string =>
  sql
    .replace(/'name-variants', '\{.*?\}'\)/g, "'name-variants', '<variants>')")
    .replace(
      /set (`|")value(`|") = '\{.*?\}' where (`|")key(`|") = 'name-variants'/g,
      "set $1value$2 = '<variants>' where $3key$4 = 'name-variants'",
    )
    .replace(/\r\n/g, "\n")
    .trim();
