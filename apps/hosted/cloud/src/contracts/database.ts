import { Redacted, Schema } from "effect";

/** The local database URL is shared by migrations and the development web process. */
export const cloudDevelopmentDatabaseUrl = (password: Redacted.Redacted<string>, port: number) =>
  Redacted.make(
    `postgresql://executor:${encodeURIComponent(Redacted.value(password))}@127.0.0.1:${port}/executor?sslmode=disable`,
  );

/** Local cloud development accepts an explicit loopback Postgres origin only. */
export const LocalDatabaseUrl = Schema.Redacted(
  Schema.String.check(
    Schema.makeFilter(
      (value) => {
        try {
          const url = new URL(value);
          // Validate escaped components before the infrastructure code decodes them.
          const user = decodeURIComponent(url.username);
          const password = decodeURIComponent(url.password);
          const database = decodeURIComponent(url.pathname.slice(1));
          return (
            (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
            user.length > 0 &&
            password.length > 0 &&
            database.length > 0 &&
            ![user, password, database].some((part) => part.includes("\0")) &&
            [...url.searchParams].every(
              ([key, value]) => key === "sslmode" && value === "disable",
            ) &&
            url.hash === ""
          );
        } catch {
          return false;
        }
      },
      {
        message:
          "Use a loopback Postgres URL with a user, password and database; sslmode may only be disable",
      },
    ),
  ),
);
