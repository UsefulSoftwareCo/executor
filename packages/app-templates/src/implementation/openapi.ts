/** Generate ordinary app source from the shared OpenAPI compiler. */
import { Effect, Schema } from "effect";
import { JsonObject as importedDocument } from "apps/effect";
import { SourceFiles } from "@executor-js/sdk";
import { compileOpenApiDocument } from "apps/openapi-compiler";
import type { OpenApiImport } from "../contracts/openapi.ts";
import { TemplateError, skippedOperationSummary } from "../contracts/templates.ts";
import { packageFile, sourceFiles } from "./files.ts";
const serialize = (value: unknown) => JSON.stringify(value, null, 2);
const generateDefinition = (
  entry: OpenApiImport,
  inputDocument: unknown,
  options: {
    readonly baseUrl?: string;
    readonly patches?: import("apps/openapi").OpenapiSourceOptions["patches"];
  } = {},
) =>
  compileOpenApiDocument(entry, inputDocument, options).pipe(
    Effect.map((compiled) => {
      const { operations, definitions, skipped, oauth, secrets } = compiled;
      const auth = [
        ...secrets.map(
          (method) =>
            `[${serialize(method.name)}]: secrets({ label: ${serialize(method.label)}, fields: object({ ${method.bindings.map((b) => `[${serialize(b.field)}]: string({ minLength: 1 })`).join(", ")} }) })`,
        ),
        ...oauth.map(
          (method) => `[${serialize(method.name)}]: oauth2(${serialize(method.config)})`,
        ),
      ];
      const hasAccount = auth.length > 0;
      const configuration = {
        source:
          entry.connectUrl === undefined
            ? { document: Schema.decodeUnknownSync(importedDocument)(inputDocument) }
            : { url: entry.connectUrl },
        allowedOrigin: compiled.pinnedOrigin,
        securitySchemes: compiled.schemes,
        methods: compiled.methods,
        oauth: oauth.map(({ name }) => name),
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.patches === undefined ? {} : { patches: options.patches }),
        ...(compiled.fallback === undefined ? {} : { fallbackSecurity: compiled.fallback }),
      };
      return {
        toolCount: operations.length,
        operations,
        definitions,
        configuration,
        skipped,
        methods: Object.fromEntries(secrets.map((method) => [method.name, method.bindings])),
        oauth: oauth.map(({ name }) => name),
        files: Schema.decodeUnknownSync(SourceFiles)(
          [
            {
              path: "index.ts",
              content: `${skipped.length ? "// Some API operations were not imported. skipped-operations.json lists each one and why.\n" : ""}import { defineApp${hasAccount ? ", accountOperations" : ""} } from "apps";
import { liveOpenapiOperations } from "apps/openapi";
${hasAccount ? 'import { provider } from "./provider.ts";' : ""}
import configuration from "./openapi.json";

export default defineApp({ accounts: ${hasAccount ? "{ service: provider.many() }" : "{}"} }, async ({ accounts, cache, fetch, signal }) =>
  ${hasAccount ? "accountOperations(accounts.service, async (account) => " : ""}liveOpenapiOperations({ ...configuration, cache, fetch, signal${hasAccount ? ", account" : ""} })${hasAccount ? ", { signal })" : ""},
);
`,
            },
            ...(hasAccount
              ? [
                  {
                    path: "provider.ts",
                    content: `import { defineProvider, object, string, secrets, oauth2 } from "apps"\n\nexport const provider = defineProvider({ name: ${serialize(entry.name)}, auth: {\n  ${auth.join(",\n  ")}\n} })\n`,
                  },
                ]
              : []),
            { path: "openapi.json", content: serialize(configuration) },
            ...(skipped.length
              ? [
                  {
                    path: "skipped-operations.json",
                    content: serialize(
                      skipped.map((op) => ({ ...op, summary: skippedOperationSummary(op.reason) })),
                    ),
                  },
                ]
              : []),
            packageFile(entry.name),
            // Stored workspaces list files by path; generate them in the same order.
          ].sort((a, b) => a.path.localeCompare(b.path)),
        ),
      };
    }),
    Effect.mapError((error) => new TemplateError({ code: error.code, reason: error.reason })),
  );

/** Compile credential-free metadata for bundled apps using the same importer as deployed apps. */
export const compileOpenApi = (
  entry: OpenApiImport,
  document: unknown,
  options: {
    readonly baseUrl?: string;
    readonly patches?: import("apps/openapi").OpenapiSourceOptions["patches"];
  } = {},
) =>
  generateDefinition(entry, document, options).pipe(
    Effect.map(({ operations, definitions, methods, oauth, skipped, configuration }) => ({
      operations,
      definitions,
      methods,
      oauth,
      skippedOperations: skipped,
      configuration,
    })),
  );

/** Generate editable OpenAPI source; product overrides must already be applied to the document. */
export const generateOpenApiApp = (
  entry: OpenApiImport,
  document: unknown,
  options: {
    readonly baseUrl?: string;
    readonly patches?: import("apps/openapi").OpenapiSourceOptions["patches"];
  } = {},
) =>
  Effect.gen(function* () {
    const generated = yield* generateDefinition(entry, document, options);
    return {
      toolCount: generated.toolCount,
      skippedOperations: generated.skipped,
      files: yield* sourceFiles(generated.files),
      configuration: generated.configuration,
      metadata: {
        operations: generated.operations,
        definitions: generated.definitions,
        methods: generated.methods,
        oauth: generated.oauth,
      },
    };
  });
