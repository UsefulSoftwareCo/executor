import { Context, Schema } from "effect";
import type { Kysely } from "kysely";

/** Better Auth's database shares the host-owned Effect SQL connection. */
export class AuthDatabase extends Context.Service<
  AuthDatabase,
  {
    readonly db: Kysely<unknown>;
    readonly type: "postgres";
    readonly transaction: true;
  }
>()("self-host/AuthDatabase") {}

/** Safe failure without SQL, credentials, or auth payloads. */
export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()(
  "DatabaseUnavailable",
  {
    stage: Schema.Literals(["directory", "lock", "query"]),
  },
) {}
