/** Shared Postgres configuration and SDK construction; hosts own driver lifetimes. */
import { Config, Effect, Schema } from "effect";

/** Explicit connection URL shared by Better Auth and Executor; never logged or returned. */
export const databaseUrl = Config.Redacted("DATABASE_URL").pipe(
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Schema.Redacted(
        Schema.String.check(
          Schema.makeFilter(
            (value) => {
              try {
                const url = new URL(value);
                return (
                  (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
                  url.hostname.length > 0 &&
                  url.pathname.length > 1
                );
              } catch {
                return false;
              }
            },
            { message: "DATABASE_URL must identify a Postgres database" },
          ),
        ),
      ),
    ),
  ),
);
