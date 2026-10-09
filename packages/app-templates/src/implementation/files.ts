/** Generated source boundaries and retained dependency manifests. */
import { Effect, Schema } from "effect";
import { SourceFiles, appSlug } from "@executor-js/sdk";
import { TemplateError } from "../contracts/templates.ts";
import apps from "apps/package.json" with { type: "json" };

/**
 * The exact `apps` release this host ships. Every generated app declares it, so the app keeps this
 * framework across host upgrades until its own `package.json` changes.
 */
export const appsVersion = apps.version;

/** Optional peers of `apps` at the exact versions this release is built and checked with. */
export const appsPeerVersion = (
  name: "@modelcontextprotocol/client" | "@modelcontextprotocol/core" | "graphql",
) => apps.devDependencies[name];

/** Parse generated file paths and content before handing them to a host deployment API. */
export const sourceFiles = (
  files: readonly { readonly path: string; readonly content: string }[],
) =>
  Schema.decodeUnknownEffect(SourceFiles)(files).pipe(
    Effect.mapError(
      () =>
        new TemplateError({
          code: "source_generation",
          reason: "The app source could not be generated.",
        }),
    ),
  );

/** Retain package identity and dependencies, including the exact `apps` release. */
export const packageFile = (name: string, dependencies: Readonly<Record<string, string>> = {}) => {
  // Imported display names become npm-safe names. An explicit npm scope stays intact.
  const packageName =
    name.length <= 214 && /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)
      ? name
      : appSlug(name);
  return {
    path: "package.json",
    content: JSON.stringify(
      {
        name: packageName,
        private: true,
        type: "module",
        dependencies: { apps: appsVersion, ...dependencies },
      },
      null,
      2,
    ),
  };
};
