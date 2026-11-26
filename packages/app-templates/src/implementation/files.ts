import { Effect, Schema } from "effect";
import { SourceFiles, appSlug } from "@executor-js/sdk";
import { TemplateError } from "../contracts/templates.ts";
import apps from "apps/package.json" with { type: "json" };

export const appsVersion = apps.version;

export const appsPeerVersion = (name: "@modelcontextprotocol/sdk" | "graphql") =>
  apps.devDependencies[name];

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

export const packageFile = (name: string, dependencies: Readonly<Record<string, string>> = {}) => {
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
