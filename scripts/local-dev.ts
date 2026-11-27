import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const root = dirname(dirname(self));
const developmentDirectory = join(root, ".local", "dev");
const keysFile = join(developmentDirectory, "keys.json");
const env = process.env;

type DevelopmentKeys = { apiKey: string; encryptionKey: string };

const isKeys = (value: unknown): value is DevelopmentKeys =>
  typeof value === "object" &&
  value !== null &&
  "apiKey" in value &&
  "encryptionKey" in value &&
  typeof value.apiKey === "string" &&
  /^[a-f0-9]{64}$/.test(value.apiKey) &&
  typeof value.encryptionKey === "string" &&
  /^[a-f0-9]{64}$/.test(value.encryptionKey);

const readKeys = (): DevelopmentKeys => {
  const parsed: unknown = JSON.parse(readFileSync(keysFile, "utf8"));
  if (!isKeys(parsed))
    throw new Error(`${keysFile} is invalid. Delete .local/dev to start with fresh dev data.`);
  return parsed;
};

const developmentKeys = (): DevelopmentKeys => {
  mkdirSync(developmentDirectory, { recursive: true, mode: 0o700 });
  try {
    return readKeys();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const staged = `${keysFile}.${process.pid}.tmp`;
  const keys = {
    apiKey: randomBytes(32).toString("hex"),
    encryptionKey: randomBytes(32).toString("hex"),
  };
  writeFileSync(staged, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
  try {
    linkSync(staged, keysFile);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  } finally {
    rmSync(staged, { force: true });
  }
  return readKeys();
};

const chosenDirectory =
  env.EXECUTOR_DATA_DIR !== undefined || env.EXECUTOR_DESKTOP_DATA_DIR !== undefined;
const chosenKeys = env.EXECUTOR_API_KEY !== undefined || env.EXECUTOR_ENCRYPTION_KEY !== undefined;
env.EXECUTOR_DATA_DIR ??= join(developmentDirectory, "local");
if (!chosenDirectory && !chosenKeys) {
  const keys = developmentKeys();
  env.EXECUTOR_API_KEY = keys.apiKey;
  env.EXECUTOR_ENCRYPTION_KEY = keys.encryptionKey;
}

if (env.PORTLESS_URL !== undefined && env.PORT !== undefined) {
  const served = {
    EXECUTOR_PORT: env.PORT,
    EXECUTOR_BROWSER_ORIGIN: new URL(env.PORTLESS_URL).origin,
  };
  for (const [name, value] of Object.entries(served)) {
    if (env[name] !== undefined && env[name] !== value)
      console.error(`${name} is ignored behind the dev proxy; using ${value}.`);
    env[name] = value;
  }
}

if (env.NODE_OPTIONS !== undefined) {
  const options = env.NODE_OPTIONS.replace(`--import="${self}"`, "").trim();
  if (options === "") delete env.NODE_OPTIONS;
  else env.NODE_OPTIONS = options;
}
