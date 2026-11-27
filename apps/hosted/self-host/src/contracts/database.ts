import { Context, Schema } from "effect";
import type { Kysely } from "kysely";

export class AuthDatabase extends Context.Service<
  AuthDatabase,
  {
    readonly db: Kysely<unknown>;
    readonly type: "postgres";
    readonly transaction: true;
  }
>()("self-host/AuthDatabase") {}

export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()(
  "DatabaseUnavailable",
  {
    stage: Schema.Literals(["directory", "lock", "query"]),
  },
) {}
