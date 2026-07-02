import { defineConfig } from "prisma/config";

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL!,
  },
  schema: process.env.PRISMA_SCHEMA!,
});
