import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { openapiAppFiles } from "../support/authored-templates.ts";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import {
  openapiErrorUpstream,
  openapiSecretMarker,
  openapiMemoryMessage,
  openapiMemoryRecovery,
  openapiConflictRecovery,
  openapiDeniedMessage,
  openapiOAuthMessage,
  openapiConflictMessage,
  openapiRetryRecovery,
} from "../support/openapi-error-upstream.ts";
import { appsManifest } from "../support/apps-release.ts";
import {
  declaredAdvice,
  expectUnknownOutcome,
  unknownOutcomeAction,
  unknownOutcomeRecovery,
} from "../support/write-outcome.ts";

const Recovery = Schema.Struct({ action: Schema.String, instructions: Schema.String });
const Failure = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      kind: Schema.String,
      message: Schema.String,
      response: Schema.optional(
        Schema.Struct({
          code: Schema.String,
          status: Schema.Number,
          message: Schema.String,
          recovery: Schema.optional(Recovery),
          retryable: Schema.Boolean,
        }),
      ),
    }),
  }),
});

/** Executor's recovery for an API's declared error that states no recovery of its own. */
const declaredRecovery = (code: string, status: number) => ({
  action: "Read the API’s error to determine the next step.",
  instructions: `An API the app calls returned an error its OpenAPI document declares (${code}, HTTP ${status}). Read its message to decide whether the input, the account's access or the API is at fault.`,
});

/** The running product's published memory and OAuth error schemas, which the fixture API uses. */
const publishedErrorSchemas = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const spec = yield* body(
    Schema.Struct({
      components: Schema.Struct({ schemas: Schema.Record(Schema.String, Schema.Unknown) }),
    }),
    yield* api.request(actors.owner, "GET", "/openapi.json"),
  );
  const memory = spec.components.schemas.BuildMemoryExceededEncoded;
  const oauthFailure = spec.components.schemas.OAuthSetupFailedEncoded;
  if (memory === undefined || oauthFailure === undefined)
    return yield* Effect.die("The public API must declare memory and OAuth failures");
  return { memory, oauthFailure };
});

layer(HostedLive, { excludeTestServices: true })("OpenAPI errors", (it) => {
  it.effect(scenarios.openapiErrors.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const { memory, oauthFailure } = yield* publishedErrorSchemas;
        for (const schema of [memory, oauthFailure]) {
          expect(schema).toMatchObject({
            properties: {
              message: { type: "string" },
              recovery: {
                type: "object",
                properties: { action: { type: "string" }, instructions: { type: "string" } },
                required: ["action", "instructions"],
              },
            },
          });
          expect(schema).toHaveProperty(
            "required",
            expect.arrayContaining(["_tag", "message", "recovery"]),
          );
        }
        const origin = yield* openapiErrorUpstream(memory, oauthFailure);
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        // Hosted authorization deliberately hides apps outside the caller's accessible set.
        const denied = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/app_missing-openapi-error-proof`,
        );
        expect(denied.status).toBe(403);
        expect(denied.body).toMatchObject({
          _tag: "OrganizationForbidden",
          message:
            "Your current membership or role does not allow this action in this organization.",
        });
        yield* evidence.json("http-error-message.json", denied.body);
        const imported = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: "OpenAPI error proof",
          files: openapiAppFiles("OpenAPI error proof", {
            url: `${origin}/openapi.json`,
            allowedOrigin: origin,
            baseUrl: origin,
            securitySchemes: {},
          }),
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* body(App, imported);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorize;
        yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "openapi-errors",
        );
        const invoke = (mode: string) =>
          client.use(`Call ${mode} through OpenAPI and MCP`, (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(app.slug)}].failures.fail({query:{mode:${JSON.stringify(mode)}}});`,
                },
              },
              undefined,
              { signal },
            ),
          );
        const known = yield* invoke("known");
        yield* evidence.json("openapi-memory-error.json", known);
        const error = (yield* Schema.decodeUnknownEffect(Failure)(known.structuredContent))
          .execution.error;
        expect(error.kind).toBe("ToolFailure");
        expect(error.response?.code).toBe("BuildMemoryExceeded");
        expect(error.response?.status).toBe(422);
        expect(error.response?.message).toBe(openapiMemoryMessage);
        expect(error.response?.recovery).toEqual(openapiMemoryRecovery);
        expect(error.message).toBe(
          `BuildMemoryExceeded (HTTP 422): ${openapiMemoryMessage} Recovery: ${openapiMemoryRecovery.action} Retryable (unchanged call): no.`,
        );
        // A declared 4xx error is not one a repeat of the same call can fix.
        expect(error.response?.retryable).toBe(false);
        expect(JSON.stringify(known)).not.toContain(openapiSecretMarker);
        const dynamic = yield* invoke("dynamic");
        expect(dynamic.structuredContent).toMatchObject({
          execution: {
            ok: false,
            error: {
              response: {
                code: "OAuthSetupFailed",
                status: 422,
                message: openapiOAuthMessage,
                recovery: openapiMemoryRecovery,
              },
            },
          },
        });
        const extras = yield* invoke("extras");
        expect(extras.structuredContent).toMatchObject({
          execution: {
            ok: false,
            error: {
              response: {
                code: "Conflict",
                status: 422,
                message: "Read the current revision before saving again.",
              },
            },
          },
        });
        expect(JSON.stringify(extras)).not.toContain(openapiSecretMarker);
        // A malformed optional recovery keeps the declared error and is not forwarded; the agent
        // gets Executor's own explanation of the declared error instead.
        const extrasError = (yield* Schema.decodeUnknownEffect(Failure)(extras.structuredContent))
          .execution.error;
        expect(extrasError.response?.recovery).toEqual(declaredRecovery("Conflict", 422));
        const conflict = yield* invoke("conflict-recovery");
        expect(conflict.structuredContent).toMatchObject({
          execution: {
            ok: false,
            error: {
              message: `Conflict (HTTP 422): Read the current revision before saving again. Recovery: ${openapiConflictRecovery.action} Retryable (unchanged call): no.`,
              response: {
                code: "Conflict",
                status: 422,
                message: "Read the current revision before saving again.",
                recovery: openapiConflictRecovery,
              },
            },
          },
        });
        // A declared 403 body explains the refusal instead of the generic provider rejection.
        const denied403 = yield* invoke("declared-forbidden");
        yield* evidence.json("openapi-declared-403.json", denied403);
        const deniedError = (yield* Schema.decodeUnknownEffect(Failure)(
          denied403.structuredContent,
        )).execution.error;
        expect(deniedError.message).toBe(
          `ExportDenied (HTTP 403): ${openapiDeniedMessage} Recovery: ${declaredRecovery("ExportDenied", 403).action} Retryable (unchanged call): no.`,
        );
        expect(deniedError.response).toEqual({
          code: "ExportDenied",
          status: 403,
          message: openapiDeniedMessage,
          recovery: declaredRecovery("ExportDenied", 403),
          retryable: false,
        });
        expect(JSON.stringify(denied403)).not.toContain("We could not identify the cause");
        // Rate-limit headers remain authoritative even when the body matches a declared error.
        const limited403 = (yield* Schema.decodeUnknownEffect(Failure)(
          (yield* invoke("declared-limited")).structuredContent,
        )).execution.error;
        expect(limited403.response).toMatchObject({ code: "AppProviderFailed", status: 502 });
        expect(limited403.message).toContain("limiting requests");
        // Input validation names the failing field and expected type without echoing the value.
        const invalidInput = yield* client.use(
          "Call the OpenAPI tool with invalid input",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(app.slug)}].failures.fail({query:{mode:{hidden:${JSON.stringify(openapiSecretMarker)}}}});`,
                },
              },
              undefined,
              { signal },
            ),
        );
        yield* evidence.json("mcp-input-invalid.json", invalidInput);
        const inputError = (yield* Schema.decodeUnknownEffect(Failure)(
          invalidInput.structuredContent,
        )).execution.error;
        expect(inputError.message).toBe(
          "InputInvalid (HTTP 422): Input failed validation: input.query.mode: Expected string Recovery: Change the input to the shape each problem expects, then call the tool again. Retryable (unchanged call): no.",
        );
        expect(inputError.response).toMatchObject({ code: "InputInvalid", status: 422 });
        expect(JSON.stringify(invalidInput)).not.toContain(openapiSecretMarker);
        // A request body that fits none of its media types names each alternative, the key that
        // selects one, and what the closest alternative needs, without the declared media types.
        const invalidBody = yield* client.use(
          "Call the OpenAPI tool with a request body for no media type",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(app.slug)}].wire.postWire(${JSON.stringify(
                    { path: { id: { role: "admin" } }, body: { ids: openapiSecretMarker } },
                  )});`,
                },
              },
              undefined,
              { signal },
            ),
        );
        yield* evidence.json("mcp-request-body-invalid.json", invalidBody);
        const bodyError = (yield* Schema.decodeUnknownEffect(Failure)(
          invalidBody.structuredContent,
        )).execution.error;
        // The generated tool is a mutation, and the app's code refused the input after it received
        // the call, so the refusal leads with the instruction not to repeat the call.
        expect(bodyError.message).toBe(
          `InputInvalid (HTTP 422): Input failed validation: input: Expected object {path, cookie?, body, contentType?} or object {path, cookie?, body, contentType}, told apart by contentType. Closest is alternative 1, whose problems follow; input.body.ids: Expected array Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
        );
        expect(JSON.stringify(invalidBody)).not.toContain(openapiSecretMarker);
        expect(bodyError.message).not.toContain("application/");
        // The discriminator's mapping picks the closest alternative, even though every alternative
        // declares the discriminator as a plain string. Mapped values are not listed.
        const invalidPet = yield* client.use(
          "Call the OpenAPI tool with a discriminated body missing a field",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(app.slug)}].pets.adopt({body: {petType: "dog"}});`,
                },
              },
              undefined,
              { signal },
            ),
        );
        yield* evidence.json("mcp-discriminated-body-invalid.json", invalidPet);
        const petError = (yield* Schema.decodeUnknownEffect(Failure)(invalidPet.structuredContent))
          .execution.error;
        expect(petError.message).toBe(
          `InputInvalid (HTTP 422): Input failed validation: input.body: Expected object {petType, meow, ...} or object {petType, bark, ...}, told apart by petType. Closest is alternative 2, whose problems follow; input.body.bark: Missing key. Expected boolean Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
        );
        expect(petError.message.toLowerCase()).not.toContain("dog");
        // The interpreter only exposes Error.message inside catch; its JSON envelope retains the same fields.
        const caught = yield* client.use(
          "Catch the declared API error in agent code",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `try { await tools[${JSON.stringify(app.slug)}].failures.fail({query:{mode:"known"}}); } catch(error) { return JSON.parse(error.message); }`,
                },
              },
              undefined,
              { signal },
            ),
        );
        expect(caught.structuredContent).toMatchObject({
          execution: {
            ok: true,
            value: {
              code: "BuildMemoryExceeded",
              status: 422,
              message: openapiMemoryMessage,
              recovery: openapiMemoryRecovery,
            },
          },
        });
        for (const [input, expectedBody, contentType] of [
          [
            {
              path: { id: { role: "admin" } },
              cookie: { theme: "dark" },
              body: { ids: ["a", "b"] },
            },
            "ids=a|b",
            "application/x-www-form-urlencoded",
          ],
          [
            {
              path: { id: { role: "admin" } },
              cookie: { theme: "dark" },
              contentType: "application/json",
              body: false,
            },
            "false",
            "application/json",
          ],
        ] as const) {
          const wire = yield* client.use(
            "Call the imported Swagger request through MCP",
            (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `return await tools[${JSON.stringify(app.slug)}].wire.postWire(${JSON.stringify(input)});`,
                  },
                },
                undefined,
                { signal },
              ),
          );
          yield* evidence.json(
            `swagger-${contentType.includes("json") ? "json" : "form"}-wire.json`,
            wire,
          );
          expect(wire.structuredContent, JSON.stringify(wire.structuredContent)).toMatchObject({
            execution: {
              ok: true,
              value: {
                url: "/wire/;role=admin",
                cookie: "theme=dark",
                body: expectedBody,
                contentType,
              },
            },
          });
        }
        for (const mode of [
          "unknown",
          "unsupported",
          "unsupported-response",
          "ref-sibling",
          "constrained",
          "invalid",
          "missing-message",
          "invalid-message",
          "long-message",
          "empty-message",
          "wrong-status",
          "malformed",
          "html",
          "oversized",
          "chunked",
          "slow",
          "unauthorized",
          "forbidden",
          "limited",
          "bad-gateway",
        ]) {
          const result = yield* invoke(mode);
          const failure = (yield* Schema.decodeUnknownEffect(Failure)(result.structuredContent))
            .execution.error;
          expect(failure.kind).toBe("ToolFailure");
          expect(JSON.stringify(result)).not.toContain(openapiSecretMarker);
          if (mode === "bad-gateway") {
            // A service's server error says a retry may help and how far to take it, so an agent
            // stops instead of repeating the call in a loop. It does not claim who caused it.
            expect(failure.response).toMatchObject({
              code: "AppProviderFailed",
              status: 502,
              retryable: true,
              message:
                "The connected service returned a server error (HTTP 502) while calling a tool.",
              recovery: {
                action:
                  "Wait at least 30 seconds before trying again, at most twice. If it keeps failing, report the repeated server error.",
                instructions: expect.stringContaining(
                  "The response does not identify the root cause.",
                ),
              },
            });
            expect(failure.message).toMatch(/ Retryable \(unchanged call\): yes\.$/);
            yield* evidence.json("mcp-provider-bad-gateway.json", result);
            continue;
          }
          if (["unauthorized", "forbidden", "limited"].includes(mode)) {
            expect(failure.response).toMatchObject({
              code: "AppProviderFailed",
              status: 502,
              message: expect.stringContaining(
                mode === "unauthorized"
                  ? "rejected the credentials"
                  : mode === "limited"
                    ? "limiting requests"
                    : "refused the request",
              ),
              recovery: {
                action: expect.stringContaining(
                  mode === "unauthorized"
                    ? "Check how the request authenticates"
                    : mode === "limited"
                      ? "Wait for the service’s rate limit"
                      : "Check the service’s access requirements",
                ),
              },
            });
            expect(failure.message).toContain("Recovery:");
            // Only the rate limit can clear by waiting; the refusals need a change first.
            expect(failure.response?.retryable).toBe(mode === "limited");
            expect(failure.response?.message).toContain(
              `(HTTP ${mode === "unauthorized" ? 401 : mode === "limited" ? 429 : 403})`,
            );
            yield* evidence.json(`mcp-provider-${mode}.json`, result);
            const httpResult = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/${app.id}/tools/call`,
              { tool: "failures.fail", kind: "query", input: { query: { mode } } },
            );
            expect(httpResult.body).toMatchObject({
              _tag: "AppProviderFailed",
              message: expect.any(String),
              reason:
                mode === "unauthorized"
                  ? "unauthorized"
                  : mode === "limited"
                    ? "rate_limited"
                    : "rejected",
            });
          } else {
            // Undeclared failures name the failed operation and response without its body, and
            // do not claim whether the request, the service or Executor caused them.
            expect(failure.response).toMatchObject({
              code: "ToolCallFailed",
              status: 502,
              retryable: false,
              recovery: {
                instructions: expect.stringContaining(
                  "The reported details do not establish whether the cause is the request, the service or this instance.",
                ),
              },
            });
            expect(failure.message).toMatch(
              /^ToolCallFailed \(HTTP 502\): The app's API call failed: GET \/failure responded with HTTP \d+ \((application\/json|text\/html)(, \d+ bytes)?\), which matches no error with a message in the API's OpenAPI document\./,
            );
            expect(failure.message).toContain(
              "Recovery: Read the reported error and check the corresponding request or configuration. Retryable (unchanged call): no.",
            );
            expect(failure.message).not.toContain("then retry");
          }
        }
        // An undeclared 404 names the method and templated path, never the parameter values or body.
        const missing = yield* client.use(
          "Call an operation the API does not serve",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(app.slug)}].items.getItem({path:{item:${JSON.stringify(openapiSecretMarker)}}});`,
                },
              },
              undefined,
              { signal },
            ),
        );
        yield* evidence.json("openapi-undeclared-404.json", missing);
        expect(
          (yield* Schema.decodeUnknownEffect(Failure)(missing.structuredContent)).execution.error
            .message,
        ).toBe(
          `ToolCallFailed (HTTP 502): The app's API call failed: GET /items/{item} responded with HTTP 404 (text/plain, ${openapiSecretMarker.length} bytes), which matches no error with a message in the API's OpenAPI document. Recovery: Read the reported error and check the corresponding request or configuration. Retryable (unchanged call): no.`,
        );
        expect(JSON.stringify(missing)).not.toContain(openapiSecretMarker);
        // The service saves the record, then fails with a server error. The call may have
        // written, so the agent is told not to repeat it, unlike the same error on a read above.
        const records = `tools[${JSON.stringify(app.slug)}].records`;
        const created = yield* client.use(
          "Create a record the service saves before failing",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await ${records}.createRecord({ body: { name: "first" } });`,
                },
              },
              undefined,
              { signal },
            ),
        );
        yield* evidence.json("mcp-provider-bad-gateway-write.json", created);
        const write = (yield* Schema.decodeUnknownEffect(Failure)(created.structuredContent))
          .execution.error;
        expect(write.response).toMatchObject({
          code: "AppProviderFailed",
          status: 502,
          retryable: false,
          message: "The connected service returned a server error (HTTP 502) while calling a tool.",
        });
        // The read's bounded retry advice is quoted as a read's, never offered for a call that
        // may have written.
        expectUnknownOutcome(
          write.response?.recovery,
          "For a call that only reads, the advice for this failure is: “Wait at least 30 seconds before trying again, at most twice.",
        );
        expect(write.message).toBe(
          `AppProviderFailed (HTTP 502): ${write.response?.message} Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
        );
        expect(JSON.stringify(created)).not.toContain(openapiSecretMarker);
        // The HTTP API records that this call may have written; the same failure of a call named a
        // read does not. A call that names no kind stays outcome unknown whatever the catalog says.
        const writeOverHttp = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/${app.id}/tools/call`,
          { tool: "records.createRecord", input: { body: { name: "second" } } },
        );
        expect(writeOverHttp.status, JSON.stringify(writeOverHttp.body)).toBe(502);
        expect(writeOverHttp.body).toMatchObject({
          _tag: "AppProviderFailed",
          reason: "unavailable",
          status: 502,
          mayHaveWritten: true,
          recovery: { action: unknownOutcomeAction },
        });
        const readOverHttp = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/${app.id}/tools/call`,
          { tool: "failures.fail", kind: "query", input: { query: { mode: "bad-gateway" } } },
        );
        expect(readOverHttp.status, JSON.stringify(readOverHttp.body)).toBe(502);
        expect(readOverHttp.body).toMatchObject({
          _tag: "AppProviderFailed",
          reason: "unavailable",
          recovery: {
            action: expect.stringContaining("Wait at least 30 seconds before trying again"),
          },
        });
        expect(readOverHttp.body).not.toHaveProperty("mayHaveWritten");
        // A safe read shows why a repeat would be wrong: the service kept both records.
        const listed = yield* client.use(
          "Read the records after the failed writes",
          (client, signal) =>
            client.callTool(
              { name: "execute", arguments: { code: `return await ${records}.listRecords({});` } },
              undefined,
              { signal },
            ),
        );
        expect(listed.structuredContent).toMatchObject({
          execution: { ok: true, value: { records: ["first", "second"] } },
        });
        const broken = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
            name: "Evaluation error proof",
            files: [
              {
                path: "index.ts",
                content: `import { defineApp } from "apps";
export default defineApp({}, async () => {
  throw new Error("Synthetic factory failure");
});`,
              },
              appsManifest,
            ],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${broken.id}`).pipe(Effect.orDie),
        );
        const discovered = yield* client.use(
          "Discover an app that cannot evaluate",
          (client, signal) =>
            client.callTool(
              { name: "execute", arguments: { code: "return await tools.search({});" } },
              undefined,
              { signal },
            ),
        );
        const discovery = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            unavailableApps: Schema.Array(
              Schema.Struct({ app: Schema.String, reason: Schema.String }),
            ),
          }),
        )(discovered.structuredContent);
        const evaluation = discovery.unavailableApps.find((entry) => entry.app === broken.id);
        expect(evaluation).toBeDefined();
        const detail = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              code: Schema.String,
              status: Schema.Number,
              message: Schema.String,
              recovery: Recovery,
            }),
          ),
        )(evaluation?.reason);
        // The factory's own error explains why the tools could not load.
        expect(detail).toMatchObject({
          code: "AppEvaluationFailed",
          status: 502,
          message:
            "Could not load this app’s tool definitions. The app threw Error: Synthetic factory failure",
          recovery: {
            action: "Try again. If this continues, investigate this error and fix its cause.",
          },
        });
        expect(JSON.stringify(discovered)).not.toContain(openapiSecretMarker);
        yield* evidence.json("mcp-evaluation-error.json", discovered);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
  it.effect(scenarios.openapiBulkWritePartlyCommitted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const { memory, oauthFailure } = yield* publishedErrorSchemas;
        const origin = yield* openapiErrorUpstream(memory, oauthFailure);
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const imported = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: "OpenAPI bulk writes",
          files: openapiAppFiles("OpenAPI bulk writes", {
            url: `${origin}/openapi.json`,
            allowedOrigin: origin,
            baseUrl: origin,
            securitySchemes: {},
          }),
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* body(App, imported);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "OpenAPI bulk writes",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "openapi-bulk-writes", {
          organization: actors.organization.id,
        });
        const records = `tools[${JSON.stringify(app.slug)}].records`;
        const execute = (label: string, code: string) =>
          client.use(label, (client, signal) =>
            client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
          );
        const save = (label: string, names: ReadonlyArray<string>) =>
          execute(
            label,
            `return await ${records}.createRecords({ body: { names: ${JSON.stringify(names)} } });`,
          );
        const saved = yield* save("Save a record", ["alpha"]);
        expect(saved.structuredContent).toMatchObject({
          execution: { ok: true, value: { saved: ["alpha"] } },
        });

        // The service saves "beta", then refuses with its own declared error and its own advice
        // to try again. Repeating the request would save "beta" twice, so the declared code,
        // status and message stay, but Executor's recovery leads and the API's advice follows
        // only quoted as the API's words, never as a step to take.
        const conflicted = yield* save("Save records the service partly saves before a conflict", [
          "beta",
          "conflict",
        ]);
        yield* evidence.json("mcp-bulk-declared-conflict.json", conflicted);
        const conflict = (yield* Schema.decodeUnknownEffect(Failure)(conflicted.structuredContent))
          .execution.error;
        expect(conflict.response).toMatchObject({
          code: "StoreConflict",
          status: 409,
          message: openapiConflictMessage,
          retryable: false,
        });
        expectUnknownOutcome(conflict.response?.recovery);
        expect(conflict.response?.recovery).toEqual(
          unknownOutcomeRecovery(
            declaredAdvice(`${openapiRetryRecovery.action} ${openapiRetryRecovery.instructions}`),
          ),
        );
        expect(conflict.message).toBe(
          `StoreConflict (HTTP 409): ${openapiConflictMessage} Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
        );
        // A program can read the same from a caught error.
        const caught = yield* execute(
          "Read the declared conflict from a caught error",
          `try { await ${records}.createRecords({ body: { names: ["conflict"] } }); return "saved"; } catch (error) { const { retryable, recovery } = JSON.parse(error.message); return { retryable, action: recovery.action }; }`,
        );
        expect(caught.structuredContent).toMatchObject({
          execution: { ok: true, value: { retryable: false, action: unknownOutcomeAction } },
        });

        // A declared error without the service's own advice keeps Executor's explanation of it.
        const rejected = yield* save(
          "Save records the service partly saves before an invalid one",
          ["gamma", ""],
        );
        yield* evidence.json("mcp-bulk-declared-invalid.json", rejected);
        const invalid = (yield* Schema.decodeUnknownEffect(Failure)(rejected.structuredContent))
          .execution.error;
        expect(invalid.response).toMatchObject({
          code: "InvalidRecord",
          status: 422,
          message: "Record names must not be empty.",
          retryable: false,
        });
        expectUnknownOutcome(
          invalid.response?.recovery,
          "An API the app calls returned an error its OpenAPI document declares (InvalidRecord, HTTP 422).",
        );
        expect(invalid.message).toBe(
          `InvalidRecord (HTTP 422): Record names must not be empty. Recovery: ${unknownOutcomeAction} Retryable (unchanged call): no.`,
        );

        // The HTTP API keeps the declared error and records that the call may have written.
        const overHttp = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/${app.id}/tools/call`,
          {
            tool: "records.createRecords",
            input: { body: { names: ["delta", ""] } },
          },
        );
        expect(overHttp.status, JSON.stringify(overHttp.body)).toBe(502);
        expect(overHttp.body).toMatchObject({
          _tag: "ToolCallFailed",
          response: { code: "InvalidRecord", status: 422 },
          mayHaveWritten: true,
          recovery: { action: unknownOutcomeAction },
        });

        // Every failed request saved its records before the error.
        const listed = yield* execute(
          "Read the records after the failed writes",
          `return await ${records}.listRecords({});`,
        );
        expect(listed.structuredContent).toMatchObject({
          execution: { ok: true, value: { records: ["alpha", "beta", "gamma", "delta"] } },
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
