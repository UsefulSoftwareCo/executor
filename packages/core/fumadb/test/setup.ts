import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll } from "vitest";

const sqlitePath = path.join(
  import.meta.dirname,
  "../node_modules/sqlite.sqlite",
);
const prismaDir = path.join(import.meta.dirname, "./prisma");

const cleanupFiles = () => {
  fs.rmSync(sqlitePath, { force: true });
  fs.rmSync(prismaDir, { recursive: true, force: true });
};

afterAll(() => {
  cleanupFiles();
});
