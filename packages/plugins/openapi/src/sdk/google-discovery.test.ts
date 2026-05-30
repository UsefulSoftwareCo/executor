import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { buildToolTypeScriptPreview } from "@executor-js/sdk/core";

import {
  convertGoogleDiscoveryBundleToOpenApi,
  convertGoogleDiscoveryToOpenApi,
} from "./google-discovery";
import { extract } from "./extract";
import { parse } from "./parse";

const ConvertedOperation = Schema.Struct({
  operationId: Schema.String,
  "x-executor-toolPath": Schema.String,
  parameters: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      in: Schema.String,
      required: Schema.Boolean,
      description: Schema.optional(Schema.String),
      schema: Schema.Unknown,
      style: Schema.optional(Schema.String),
      explode: Schema.optional(Schema.Boolean),
      allowReserved: Schema.optional(Schema.Boolean),
    }),
  ),
  servers: Schema.optional(Schema.Array(Schema.Struct({ url: Schema.String }))),
  security: Schema.optional(
    Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  ),
  "x-executor-pathTemplate": Schema.optional(Schema.String),
  requestBody: Schema.optional(Schema.Unknown),
  responses: Schema.Unknown,
  "x-google-scopes": Schema.Array(Schema.String),
});

const ConvertedSpec = Schema.Struct({
  openapi: Schema.String,
  servers: Schema.Array(Schema.Struct({ url: Schema.String })),
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, ConvertedOperation)),
  components: Schema.Struct({
    schemas: Schema.Record(Schema.String, Schema.Unknown),
  }),
});

const decodeConvertedSpec = Schema.decodeUnknownSync(Schema.fromJsonString(ConvertedSpec));

const normalizeOpenApiRefsForPreview = (node: unknown): unknown => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(normalizeOpenApiRefsForPreview);
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    const match = obj.$ref.match(/^#\/components\/schemas\/(.+)$/);
    return match ? { ...obj, $ref: `#/$defs/${match[1]}` } : obj;
  }
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [key, normalizeOpenApiRefsForPreview(value)]),
  );
};

it.effect("converts Google Discovery documents into Executor-preserving OpenAPI 3 specs", () =>
  Effect.gen(function* () {
    const result = yield* convertGoogleDiscoveryToOpenApi({
      discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      documentText: JSON.stringify({
        name: "gmail",
        version: "v1",
        title: "Gmail API",
        rootUrl: "https://gmail.googleapis.com/",
        servicePath: "",
        auth: {
          oauth2: {
            scopes: {
              "https://www.googleapis.com/auth/gmail.metadata": {
                description: "Read metadata",
              },
            },
          },
        },
        resources: {
          users: {
            resources: {
              messages: {
                methods: {
                  list: {
                    id: "gmail.users.messages.list",
                    httpMethod: "GET",
                    path: "gmail/v1/users/{userId}/messages",
                    scopes: ["https://www.googleapis.com/auth/gmail.metadata"],
                    parameters: {
                      userId: {
                        location: "path",
                        required: true,
                        type: "string",
                        description: "The user's email address. The special value me can be used.",
                      },
                      metadataHeaders: {
                        location: "query",
                        repeated: true,
                        type: "string",
                      },
                    },
                  },
                },
              },
              drafts: {
                methods: {
                  create: {
                    id: "gmail.users.drafts.create",
                    httpMethod: "POST",
                    path: "gmail/v1/users/{userId}/drafts",
                    request: { $ref: "Draft" },
                    response: { $ref: "Draft" },
                    scopes: ["https://www.googleapis.com/auth/gmail.metadata"],
                    parameters: {
                      userId: {
                        location: "path",
                        required: true,
                        type: "string",
                      },
                    },
                  },
                },
              },
            },
          },
        },
        schemas: {
          Draft: {
            id: "Draft",
            type: "object",
            description: "A draft email.",
            properties: {
              id: {
                type: "string",
                description: "The immutable ID of the draft.",
              },
              message: {
                $ref: "Message",
              },
            },
          },
          Message: {
            id: "Message",
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              labelIds: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      }),
    });

    const spec = decodeConvertedSpec(result.specText);
    const operation = spec.paths["/gmail/v1/users/{userId}/messages"]?.get;
    const createDraft = spec.paths["/gmail/v1/users/{userId}/drafts"]?.post;
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers).toEqual([{ url: "https://gmail.googleapis.com/" }]);
    expect(result.specText).not.toContain("_tag");
    expect(operation).toMatchObject({
      operationId: "users.messages.list",
      "x-executor-toolPath": "users.messages.list",
      "x-google-scopes": ["https://www.googleapis.com/auth/gmail.metadata"],
    });
    expect(operation?.security).toEqual([
      { googleOAuth2: ["https://www.googleapis.com/auth/gmail.metadata"] },
    ]);
    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({
        name: "metadataHeaders",
        in: "query",
        style: "form",
        explode: true,
      }),
    );
    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({
        name: "userId",
        description: "The user's email address. The special value me can be used.",
        schema: expect.objectContaining({ type: "string" }),
      }),
    );
    expect(createDraft).toMatchObject({
      operationId: "users.drafts.create",
      "x-executor-toolPath": "users.drafts.create",
    });
    expect(createDraft).toMatchObject({
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Draft" },
          },
        },
      },
    });
    expect(createDraft?.parameters).toContainEqual(
      expect.objectContaining({
        name: "userId",
        schema: expect.objectContaining({ type: "string" }),
      }),
    );

    const parsed = yield* parse(result.specText);
    const extracted = yield* extract(parsed);
    const extractedDraftCreate = extracted.operations.find(
      (candidate) => candidate.operationId === "users.drafts.create",
    );
    expect(extractedDraftCreate?.operationId).toBe("users.drafts.create");
    const preview = yield* Effect.promise(() =>
      buildToolTypeScriptPreview({
        inputSchema: normalizeOpenApiRefsForPreview(
          extractedDraftCreate
            ? Option.getOrUndefined(extractedDraftCreate.inputSchema)
            : undefined,
        ),
        outputSchema: normalizeOpenApiRefsForPreview(
          extractedDraftCreate
            ? Option.getOrUndefined(extractedDraftCreate.outputSchema)
            : undefined,
        ),
        defs: new Map(
          Object.entries(spec.components.schemas).map(([name, schema]) => [
            name,
            normalizeOpenApiRefsForPreview(schema),
          ]),
        ),
      }),
    );
    expect(preview.inputTypeScript).toBe("{ userId: string; body?: Draft; }");
    expect(preview.outputTypeScript).toBe("Draft");
    expect(preview.typeScriptDefinitions).toMatchObject({
      Draft: "{ id?: string; message?: Message; }",
      Message: "{ id?: string; labelIds?: string[]; }",
    });
    expect(result.oauth2?.identityScopes).toEqual(["openid", "email", "profile"]);
  }),
);

it.effect("bundles Google Discovery documents into one Google OpenAPI source", () =>
  Effect.gen(function* () {
    const result = yield* convertGoogleDiscoveryBundleToOpenApi({
      documents: [
        {
          discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          documentText: JSON.stringify({
            name: "gmail",
            version: "v1",
            title: "Gmail API",
            rootUrl: "https://gmail.googleapis.com/",
            servicePath: "",
            auth: {
              oauth2: {
                scopes: {
                  "https://www.googleapis.com/auth/gmail.metadata": {
                    description: "Read metadata",
                  },
                },
              },
            },
            resources: {
              users: {
                resources: {
                  messages: {
                    methods: {
                      list: {
                        id: "gmail.users.messages.list",
                        httpMethod: "GET",
                        path: "gmail/v1/users/{userId}/messages",
                        response: { $ref: "Message" },
                        scopes: ["https://www.googleapis.com/auth/gmail.metadata"],
                        parameters: {
                          userId: {
                            location: "path",
                            required: true,
                            type: "string",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            schemas: {
              Message: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
              },
            },
          }),
        },
        {
          discoveryUrl: "https://chat.googleapis.com/$discovery/rest?version=v1",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          documentText: JSON.stringify({
            name: "chat",
            version: "v1",
            title: "Google Chat API",
            rootUrl: "https://chat.googleapis.com/",
            servicePath: "",
            auth: {
              oauth2: {
                scopes: {
                  "https://www.googleapis.com/auth/chat.spaces.readonly": {
                    description: "Read spaces",
                  },
                },
              },
            },
            resources: {
              spaces: {
                methods: {
                  get: {
                    id: "chat.spaces.get",
                    httpMethod: "GET",
                    path: "v1/{+name}",
                    response: { $ref: "Space" },
                    scopes: ["https://www.googleapis.com/auth/chat.spaces.readonly"],
                    parameters: {
                      name: {
                        location: "path",
                        required: true,
                        type: "string",
                      },
                    },
                  },
                },
                resources: {
                  messages: {
                    methods: {
                      get: {
                        id: "chat.spaces.messages.get",
                        httpMethod: "GET",
                        path: "v1/{+name}",
                        response: { $ref: "Message" },
                        scopes: ["https://www.googleapis.com/auth/chat.spaces.readonly"],
                        parameters: {
                          name: {
                            location: "path",
                            required: true,
                            type: "string",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            schemas: {
              Space: {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
              },
              Message: {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
              },
            },
          }),
        },
      ],
    });

    const spec = decodeConvertedSpec(result.specText);
    expect(result.title).toBe("Google");
    expect(result.baseUrl).toBe("https://www.googleapis.com/");
    expect(result.discoveryUrls).toEqual([
      "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
      "https://www.googleapis.com/discovery/v1/apis/chat/v1/rest",
    ]);
    expect(spec.servers).toEqual([{ url: "https://www.googleapis.com/" }]);
    expect(spec.components.schemas).toHaveProperty("gmail_v1_Message");
    expect(spec.components.schemas).toHaveProperty("chat_v1_Message");

    const gmailList = spec.paths["/gmail/v1/users/{userId}/messages"]?.get;
    expect(gmailList).toMatchObject({
      operationId: "gmail.users.messages.list",
      "x-executor-toolPath": "gmail.users.messages.list",
      servers: [{ url: "https://gmail.googleapis.com/" }],
    });
    expect(gmailList?.responses).toMatchObject({
      "200": {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/gmail_v1_Message" },
          },
        },
      },
    });

    const chatSpaceGet = spec.paths["/v1/{name}"]?.get;
    const chatMessageGet = spec.paths["/chat.spaces.messages.get"]?.get;
    expect(chatSpaceGet).toMatchObject({
      operationId: "chat.spaces.get",
      "x-executor-pathTemplate": "/v1/{+name}",
      servers: [{ url: "https://chat.googleapis.com/" }],
    });
    expect(chatMessageGet).toMatchObject({
      operationId: "chat.spaces.messages.get",
      "x-executor-pathTemplate": "/v1/{+name}",
      servers: [{ url: "https://chat.googleapis.com/" }],
    });
    expect(chatSpaceGet?.parameters).toContainEqual(
      expect.objectContaining({
        name: "name",
        in: "path",
        allowReserved: true,
      }),
    );

    const parsed = yield* parse(result.specText);
    const extracted = yield* extract(parsed);
    const extractedGmail = extracted.operations.find(
      (candidate) => candidate.operationId === "gmail.users.messages.list",
    );
    const extractedChatMessage = extracted.operations.find(
      (candidate) => candidate.operationId === "chat.spaces.messages.get",
    );
    expect(extractedGmail?.baseUrl).toBe("https://gmail.googleapis.com/");
    expect(extractedChatMessage?.pathTemplate).toBe("/v1/{+name}");
    expect(extractedChatMessage?.baseUrl).toBe("https://chat.googleapis.com/");
    expect(result.oauth2?.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.metadata",
      "https://www.googleapis.com/auth/chat.spaces.readonly",
    ]);
  }),
);
