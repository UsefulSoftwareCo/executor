/**
 * Every app declares the exact `apps` release it uses. Fixture apps declare the one this checkout's
 * hosts ship, which the suite's loopback registry serves; see npm-registry.ts.
 */
import { Option, Schema } from "effect";
import appsPackage from "../../packages/apps/package.json" with { type: "json" };

/** The version in `packages/apps/package.json`, imported as data from the checkout the suite runs in. */
export const appsVersion: string = appsPackage.version;

/** The `@modelcontextprotocol/sdk` version that `apps` is built with, which quick add pins. */
export const mcpSdkVersion: string = appsPackage.devDependencies["@modelcontextprotocol/sdk"];

/** A `package.json` that declares only the host's `apps` release. */
export const appsManifest = {
  path: "package.json",
  content: `${JSON.stringify({ dependencies: { apps: appsVersion } }, null, 2)}\n`,
};

/** A first migration: deploying it gives an app its database. */
export const firstMigration = {
  path: "migrations/0001_init.sql",
  content: "CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL);\n",
};
/** The files that give an app a database, or none. */
export const databaseFiles = (database: boolean | undefined) =>
  database === true ? [firstMigration] : [];

/** Add `apps` to a fixture's own dependencies. */
export const withApps = (dependencies: Readonly<Record<string, string>> = {}) => ({
  apps: appsVersion,
  ...dependencies,
});

const Dependencies = Schema.fromJsonString(
  Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }),
);

/** The `apps` version a source's `package.json` declares, if any. */
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

/**
 * A fixture's source as an `apps` release before host protocol 13 reads it: the caller's accounts
 * without a scope, `{ accounts: { mail } }` and `ctx.accounts`. Fixtures that build one app for
 * several releases write the current syntax and convert it for the older ones.
 */
export const unscopedAccounts = (source: string) =>
  source
    .replace(/\{ user: \{ accounts: (\{[^{}]*\}) \} \}/g, "{ accounts: $1 }")
    .replace(/\{ user: \{ accounts \} \}/g, "{ accounts }")
    .replace(/\.user\.accounts\b/g, ".accounts");
