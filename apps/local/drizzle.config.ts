import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/server/executor-schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
});
