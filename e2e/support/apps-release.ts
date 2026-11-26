import { Option, Schema } from "effect";
import appsPackage from "../../packages/apps/package.json" with { type: "json" };

export const appsVersion: string = appsPackage.version;

export const mcpSdkVersion: string = appsPackage.devDependencies["@modelcontextprotocol/sdk"];

export const appsManifest = {
  path: "package.json",
  content: `${JSON.stringify({ type: "module", dependencies: { apps: appsVersion } }, null, 2)}\n`,
};

export const firstMigration = {
  path: "migrations/0001_init.sql",
  content: "CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL);\n",
};
export const databaseFiles = (database: boolean | undefined) =>
  database === true ? [firstMigration] : [];

export const withApps = (dependencies: Readonly<Record<string, string>> = {}) => ({
  apps: appsVersion,
  ...dependencies,
});

const Dependencies = Schema.fromJsonString(
  Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }),
);

export const declaredApps = (
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
) => {
  const manifest = files.find((file) => file.path === "package.json");
  return manifest === undefined
    ? undefined
    : Schema.decodeUnknownOption(Dependencies)(manifest.content).pipe(
        Option.map((value) => value.dependencies.apps),
        Option.getOrUndefined,
      );
};

export const unscopedAccounts = (source: string) =>
  source
    .replace(/\{ user: \{ accounts: (\{[^{}]*\}) \} \}/g, "{ accounts: $1 }")
    .replace(/\{ user: \{ accounts \} \}/g, "{ accounts }")
    .replace(/\.user\.accounts\b/g, ".accounts");
