/** Generated source boundaries and retained dependency manifests. */
import { Effect, Schema } from "effect";
import { SourceFiles, appSlug } from "@executor-js/sdk";
import { TemplateError } from "../contracts/templates.ts";

/** Parse generated file paths and content before handing them to a host deployment API. */
export const sourceFiles = (
  files: readonly { readonly path: string; readonly content: string }[],
) =>
  Schema.decodeUnknownEffect(SourceFiles)(files).pipe(
    Effect.mapError(() => new TemplateError({ reason: "The app source could not be generated." })),
  );

/** Retain package identity and dependencies. Host-provided apps and Effect are not installed twice. */
export const packageFile = (name: string, dependencies: Readonly<Record<string, string>> = {}) => {
  // Imported display names become npm-safe names. An explicit npm scope stays intact.
  const packageName =
    name.length <= 214 && /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)
      ? name
      : appSlug(name);
  return {
    path: "package.json",
    content: JSON.stringify(
      { name: packageName, private: true, type: "module", dependencies },
      null,
      2,
    ),
  };
};
