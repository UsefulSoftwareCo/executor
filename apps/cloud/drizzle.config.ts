import { defineConfig } from "drizzle-kit";

// drizzle-kit studio reads `dbCredentials.url`; everything else (generate,
// migrate) ignores it. Default to the local PGlite socket started by
// `bun run dev:db`; override via `DATABASE_URL` for prod studio sessions.
// drizzle-kit uses node-postgres (`pg`) for studio and the `ssl` option in
// dbCredentials doesn't reliably reach the pool - append `sslmode=require`
// directly to the URL instead, which `pg` honours.
const DEFAULT_DEV_URL = "postgresql://postgres:postgres@127.0.0.1:5433/postgres";

const withSslMode = (url: string): string => {
  if (url.includes("127.0.0.1") || url.includes("localhost")) return url;
  if (/[?&]sslmode=/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "sslmode=require";
};

export default defineConfig({
  schema: ["./src/db/schema.ts", "./src/db/executor-schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: withSslMode(process.env.DATABASE_URL ?? DEFAULT_DEV_URL),
  },
});
