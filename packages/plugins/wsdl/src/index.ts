import { Effect, Option, Schema } from "effect";
import {
  definePlugin,
  IntegrationAlreadyExistsError,
  ToolName,
  ToolResult,
  type PluginCtx,
} from "@executor-js/sdk/core";
import {
  describeApiKeyAuthMethod,
  describeNoneAuthMethod,
  renderAuthPlacements,
  requiredPlacementVariables,
} from "@executor-js/sdk/http-auth";
import { parseWsdl } from "./contract";
import { jsonSchema } from "./codec";
import { invoke } from "./invoke";
import { WsdlError } from "./xml";

export { parseWsdl } from "./contract";
export type { WsdlContract, WsdlOperation, WsdlSelection } from "./contract";
export { invoke } from "./invoke";
export { WsdlError } from "./xml";

import { AddWsdlInput } from "./shared";
export { AddWsdlInput } from "./shared";
const Config = Schema.Struct({
  type: Schema.Literal("wsdl"),
  ...AddWsdlInput.fields,
});
const decodeConfigOption = Schema.decodeUnknownOption(Config);
const decodeConfig = Schema.decodeUnknownEffect(Config);
const extension = (ctx: PluginCtx) => ({
  addIntegration: (input: typeof AddWsdlInput.Type) =>
    Effect.gen(function* () {
      const checked = yield* Schema.decodeUnknownEffect(AddWsdlInput)(input).pipe(
        Effect.mapError(() => new WsdlError({ message: "Invalid WSDL integration input" })),
      );
      if (!/^[a-z][a-z0-9_-]*$/.test(checked.slug) || !checked.name.trim())
        return yield* new WsdlError({
          message:
            "Provide a name and a lowercase namespace using letters, digits, underscores, or hyphens",
        });
      yield* ctx.core.integrations.authorizeWrite();
      const contract = yield* parseWsdl(checked.wsdl, checked);
      const templates = checked.authenticationTemplate ?? [];
      if (new Set(templates.map((method) => method.slug)).size !== templates.length)
        return yield* new WsdlError({ message: "Authentication method slugs must be unique" });
      for (const method of templates)
        if (method.kind === "apikey")
          for (const placement of method.placements)
            if (
              placement.carrier === "header" &&
              ["soapaction", "content-type", "host", "content-length"].includes(
                placement.name.toLowerCase(),
              )
            )
              return yield* new WsdlError({
                message: "Authentication cannot override SOAP protocol headers",
              });
      yield* ctx.transaction(
        Effect.gen(function* () {
          if (yield* ctx.core.integrations.get(checked.slug))
            return yield* new IntegrationAlreadyExistsError({ slug: checked.slug });
          yield* ctx.core.integrations.register({
            slug: checked.slug,
            name: checked.name,
            description: `SOAP service ${contract.service}`,
            config: {
              ...checked,
              type: "wsdl",
              endpoint: contract.endpoint,
              service: contract.service,
              port: contract.port,
            },
            canRemove: true,
            canRefresh: true,
          });
        }),
      );
      return {
        slug: String(checked.slug),
        name: checked.name,
        toolCount: contract.operations.length,
      };
    }),
});

export const wsdlPlugin = definePlugin(() => ({
  id: "wsdl" as const,
  packageName: "@executor-js/plugin-wsdl",
  storage: () => ({}),
  extension,
  describeAuthMethods: (record) => {
    const decoded = decodeConfigOption(record.config);
    if (Option.isNone(decoded)) return [];
    const methods = decoded.value.authenticationTemplate ?? [];
    return methods.length
      ? methods.map((method) =>
          method.kind === "apikey"
            ? describeApiKeyAuthMethod(method)
            : describeNoneAuthMethod(method.slug),
        )
      : [describeNoneAuthMethod("none")];
  },
  staticIntegrations: (self: ReturnType<typeof extension>) => [
    {
      id: "wsdl",
      kind: "executor",
      name: "WSDL / SOAP",
      tools: [
        {
          name: "addIntegration",
          description:
            "Import a self-contained WSDL 1.1 SOAP document/literal contract. Then create a connection to expose its operations. Select service and port when ambiguous. Authentication supports HTTP header/query placements; SOAP headers are unsupported.",
          annotations: { requiresApproval: true, approvalDescription: "Add a WSDL integration" },
          inputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(AddWsdlInput)),
          handler: ({ args }) =>
            Schema.decodeUnknownEffect(AddWsdlInput)(args).pipe(
              Effect.mapError(() => new WsdlError({ message: "Invalid WSDL integration input" })),
              Effect.flatMap(self.addIntegration),
              Effect.map(ToolResult.ok),
              Effect.catchTag("WsdlError", ({ message }) =>
                Effect.succeed(ToolResult.fail({ code: "wsdl_invalid_contract", message })),
              ),
            ),
        },
      ],
    },
  ],
  resolveTools: ({ config }) =>
    Effect.gen(function* () {
      const parsed = yield* decodeConfig(config).pipe(
        Effect.mapError(() => new WsdlError({ message: "Invalid WSDL integration config" })),
      );
      const contract = yield* parseWsdl(parsed.wsdl, parsed);
      return {
        tools: contract.operations.map((operation) => ({
          name: ToolName.make(operation.name),
          description: `Call ${contract.service}.${operation.name} via SOAP`,
          inputSchema: {
            type: "object",
            properties: { body: jsonSchema(operation.input) },
            required: ["body"],
            additionalProperties: false,
          },
          annotations: {
            requiresApproval: true,
            approvalDescription: `Call SOAP operation ${operation.name}`,
          },
        })),
      };
    }).pipe(
      Effect.catch(() =>
        Effect.succeed({
          tools: [],
          incomplete: true,
          incompleteReason: "WSDL contract could not be resolved",
        }),
      ),
    ),
  invokeTool: ({ ctx, toolRow, credential, args }) =>
    Effect.gen(function* () {
      const config = yield* decodeConfig(credential.config).pipe(
        Effect.mapError(() => new WsdlError({ message: "Invalid WSDL integration config" })),
      );
      const contract = yield* parseWsdl(config.wsdl, config);
      const operation = contract.operations.find((op) => op.name === toolRow.name);
      if (!operation) return yield* new WsdlError({ message: "WSDL operation not found" });
      const input = yield* Schema.decodeUnknownEffect(Schema.Struct({ body: Schema.Unknown }))(
        args,
      ).pipe(Effect.mapError(() => new WsdlError({ message: "Expected SOAP arguments in body" })));
      const methods = config.authenticationTemplate ?? [];
      const method = methods.find((candidate) => candidate.slug === credential.template);
      if (methods.length && !method)
        return yield* new WsdlError({ message: "Unknown authentication template" });
      const placements = method?.kind === "apikey" ? method.placements : [];
      if (requiredPlacementVariables(placements).some((variable) => !credential.values[variable]))
        return ToolResult.fail({
          code: "wsdl_auth_required",
          message: "Required SOAP credentials are missing",
        });
      const auth = renderAuthPlacements(placements, credential.values);
      const endpoint = new URL(contract.endpoint);
      for (const [name, value] of Object.entries(auth.queryParams))
        endpoint.searchParams.set(name, value);
      const result = yield* invoke(operation, input.body, endpoint.toString(), auth.headers).pipe(
        Effect.provide(ctx.httpClientLayer),
      );
      if (result.ok) return ToolResult.ok(result.value);
      const redact = (text: string) =>
        Object.values(credential.values)
          .filter((value): value is string => !!value)
          .reduce((message, secret) => message.split(secret).join("[redacted]"), text);
      return ToolResult.fail({
        code: "soap_fault",
        message: redact(result.fault.message),
        details: { faultCode: redact(result.fault.code) },
      });
    }).pipe(
      Effect.catchTag("WsdlError", ({ message }) =>
        Effect.succeed(ToolResult.fail({ code: "wsdl_invocation_failed", message })),
      ),
    ),
}));
