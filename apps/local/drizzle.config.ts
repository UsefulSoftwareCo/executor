import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/executor-schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
});
