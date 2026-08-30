import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { buildToolTypeScriptPreview } from "@executor-js/sdk/core";

import {
  convertGoogleDiscoveryBundleToOpenApi,
  convertGoogleDiscoveryToOpenApi,
  isGoogleDiscoveryUrl,
  normalizeGoogleDiscoveryUrl,
  fetchGoogleDiscoveryDocument,
} from "./discovery";
import { googleOAuthConsentScopesForPreset } from "./service-policy";
import { extract, parse } from "@executor-js/plugin-openapi";

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

const OAUTH2_URL = "https://www.googleapis.com/discovery/v1/apis/oauth2/v2/rest";
const OAUTH2_USERINFO_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

const oauth2DiscoveryDoc = {
  name: "oauth2",
  version: "v2",
  title: "Google OAuth2 API",
  rootUrl: "https://www.googleapis.com/",
  servicePath: "",
  auth: {
    oauth2: {
      scopes: {
        openid: {
          description: "Associate you with your personal info on Google",
        },
        "https://www.googleapis.com/auth/userinfo.email": {
          description: "See your primary Google Account email address",
        },
        "https://www.googleapis.com/auth/userinfo.profile": {
          description: "See your personal info",
        },
      },
    },
  },
  methods: {
    tokeninfo: {
      id: "oauth2.tokeninfo",
      httpMethod: "POST",
      path: "oauth2/v2/tokeninfo",
      parameters: {
        access_token: {
          location: "query",
          type: "string",
        },
      },
      response: { $ref: "Tokeninfo" },
    },
  },
  resources: {
    userinfo: {
      methods: {
        get: {
          id: "oauth2.userinfo.get",
          httpMethod: "GET",
          path: "oauth2/v2/userinfo",
          scopes: OAUTH2_USERINFO_SCOPES,
          response: { $ref: "Userinfo" },
        },
      },
      resources: {
        v2: {
          resources: {
            me: {
              methods: {
                get: {
                  id: "oauth2.userinfo.v2.me.get",
                  httpMethod: "GET",
                  path: "userinfo/v2/me",
                  scopes: OAUTH2_USERINFO_SCOPES,
                  response: { $ref: "Userinfo" },
                },
              },
            },
          },
        },
      },
    },
  },
  schemas: {
    Tokeninfo: {
      id: "Tokeninfo",
      type: "object",
      properties: {
        audience: { type: "string" },
        scope: { type: "string" },
      },
    },
    Userinfo: {
      id: "Userinfo",
      type: "object",
      properties: {
        email: { type: "string" },
        family_name: { type: "string" },
        gender: { type: "string" },
        given_name: { type: "string" },
        hd: { type: "string" },
        id: { type: "string" },
        link: { type: "string" },
        locale: { type: "string" },
        name: { type: "string" },
        picture: { type: "string" },
        verified_email: { type: "boolean" },
      },
    },
  },
};

it("accepts only supported HTTPS Google Discovery endpoints", () => {
  expect(
    normalizeGoogleDiscoveryUrl("https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest/"),
  ).toBe("https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest");
  expect(
    normalizeGoogleDiscoveryUrl(
      "https://www.googleapis.com/discovery/v1/apis/photospicker/v1/rest",
    ),
  ).toBe("https://photospicker.googleapis.com/$discovery/rest?version=v1");
  expect(
    normalizeGoogleDiscoveryUrl("https://www.googleapis.com/discovery/v1/apis/forms/v1/rest"),
  ).toBe("https://forms.googleapis.com/$discovery/rest?version=v1");
  expect(
    normalizeGoogleDiscoveryUrl("https://www.googleapis.com/discovery/v1/apis/keep/v1/rest"),
  ).toBe("https://keep.googleapis.com/$discovery/rest?version=v1");
  expect(
    normalizeGoogleDiscoveryUrl("https://chat.googleapis.com/$discovery/rest?version=v1"),
  ).toBe("https://www.googleapis.com/discovery/v1/apis/chat/v1/rest");
  expect(
    normalizeGoogleDiscoveryUrl("https://photospicker.googleapis.com/$discovery/rest?version=v1"),
  ).toBe("https://photospicker.googleapis.com/$discovery/rest?version=v1");
  expect(
    normalizeGoogleDiscoveryUrl("https://forms.googleapis.com/$discovery/rest?version=v1"),
  ).toBe("https://forms.googleapis.com/$discovery/rest?version=v1");
  expect(
    normalizeGoogleDiscoveryUrl("https://keep.googleapis.com/$discovery/rest?version=v1"),
  ).toBe("https://keep.googleapis.com/$discovery/rest?version=v1");

  expect(isGoogleDiscoveryUrl("https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest")).toBe(
    true,
  );
  expect(isGoogleDiscoveryUrl("https://evilgoogleapis.com/discovery/v1/apis/gmail/v1/rest")).toBe(
    false,
  );
  expect(isGoogleDiscoveryUrl("http://www.googleapis.com/discovery/v1/apis/gmail/v1/rest")).toBe(
    false,
  );
  expect(
    isGoogleDiscoveryUrl("https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest?next=x"),
  ).toBe(false);
  expect(
    isGoogleDiscoveryUrl("https://token@www.googleapis.com/discovery/v1/apis/gmail/v1/rest"),
  ).toBe(false);
});

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
    // v2: the conversion now exposes a v2 oauth `authenticationTemplate` rather
    // than v1's `oauth2` source config.
    // removed: identityScopes assertion - that field belonged to the v1
    // OAuth2SourceConfig slot model, which no longer exists in v2.
    const oauthTemplate = result.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
    expect(oauthTemplate).toBeDefined();
  }),
);

it.effect("converts Google OAuth2 v2 top-level and aliased userinfo methods", () =>
  Effect.gen(function* () {
    const result = yield* convertGoogleDiscoveryToOpenApi({
      discoveryUrl: OAUTH2_URL,
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      documentText: JSON.stringify(oauth2DiscoveryDoc),
    });

    const spec = decodeConvertedSpec(result.specText);
    const userinfo = spec.paths["/oauth2/v2/userinfo"]?.get;
    const userinfoMe = spec.paths["/userinfo/v2/me"]?.get;
    const tokeninfo = spec.paths["/oauth2/v2/tokeninfo"]?.post;

    expect(userinfo).toMatchObject({
      operationId: "userinfo.get",
      "x-executor-toolPath": "userinfo.get",
      "x-google-scopes": [...OAUTH2_USERINFO_SCOPES],
    });
    expect(userinfo?.security).toEqual(
      OAUTH2_USERINFO_SCOPES.map((scope) => ({ googleOAuth2: [scope] })),
    );
    expect(userinfo?.responses).toMatchObject({
      "200": {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Userinfo" },
          },
        },
      },
    });
    expect(userinfoMe).toMatchObject({
      operationId: "userinfo.v2.me.get",
      "x-executor-toolPath": "userinfo.v2.me.get",
      "x-google-scopes": [...OAUTH2_USERINFO_SCOPES],
    });
    expect(tokeninfo).toMatchObject({
      operationId: "tokeninfo",
      "x-executor-toolPath": "tokeninfo",
    });
  }),
);

it.effect("marks Google Discovery media-download methods as binary responses", () =>
  Effect.gen(function* () {
    const result = yield* convertGoogleDiscoveryToOpenApi({
      discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      documentText: JSON.stringify({
        name: "drive",
        version: "v3",
        title: "Drive API",
        rootUrl: "https://www.googleapis.com/",
        servicePath: "drive/v3/",
        resources: {
          files: {
            methods: {
              export: {
                id: "drive.files.export",
                httpMethod: "GET",
                path: "files/{fileId}/export",
                supportsMediaDownload: true,
                useMediaDownloadService: true,
                parameters: {
                  fileId: {
                    location: "path",
                    required: true,
                    type: "string",
                  },
                  mimeType: {
                    location: "query",
                    required: true,
                    type: "string",
                  },
                },
              },
            },
          },
        },
        schemas: {},
      }),
    });

    const spec = decodeConvertedSpec(result.specText);
    const operation = spec.paths["/files/{fileId}/export"]?.get;
    expect(operation?.responses).toMatchObject({
      "200": {
        content: {
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        },
      },
    });

    const parsed = yield* parse(result.specText);
    const extracted = yield* extract(parsed);
    const exportOperation = extracted.operations.find(
      (candidate) => candidate.operationId === "files.export",
    );
    expect(exportOperation?.operationId).toBe("files.export");
    const responseFileHint = Option.flatMap(
      exportOperation?.responseBody ?? Option.none(),
      (body) => body.fileHint,
    );
    expect(Option.isSome(responseFileHint)).toBe(true);
  }),
);

it.effect("uses the versioned Google Photos raw upload endpoint", () =>
  Effect.gen(function* () {
    const result = yield* convertGoogleDiscoveryToOpenApi({
      discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/photoslibrary/v1/rest",
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      documentText: JSON.stringify({
        name: "photoslibrary",
        version: "v1",
        title: "Google Photos Library API",
        rootUrl: "https://photoslibrary.googleapis.com/",
        servicePath: "",
        auth: {
          oauth2: {
            scopes: {
              "https://www.googleapis.com/auth/photoslibrary.appendonly": {
                description: "Upload to Google Photos",
              },
            },
          },
        },
        resources: {},
        schemas: {},
      }),
    });

    const spec = decodeConvertedSpec(result.specText);
    const upload = spec.paths["/v1/uploads"]?.post;
    expect(upload).toMatchObject({
      operationId: "photoslibrary.mediaItems.upload",
      "x-executor-toolPath": "photoslibrary.mediaItems.upload",
      "x-executor-pathTemplate": "/v1/uploads",
      servers: [{ url: "https://photoslibrary.googleapis.com/" }],
    });
  }),
);

it.effect("supplies documented scopes when Picker Discovery omits auth metadata", () =>
  Effect.gen(function* () {
    const result = yield* convertGoogleDiscoveryToOpenApi({
      discoveryUrl: "https://photospicker.googleapis.com/$discovery/rest?version=v1",
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      documentText: JSON.stringify({
        name: "photospicker",
        version: "v1",
        title: "Google Photos Picker API",
        rootUrl: "https://photospicker.googleapis.com/",
        servicePath: "v1/",
        resources: {
          mediaItems: {
            methods: {
              list: {
                id: "photospicker.mediaItems.list",
                httpMethod: "GET",
                path: "mediaItems",
                parameters: {},
              },
            },
          },
        },
        schemas: {},
      }),
    });

    const pickerScope = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
    const oauthTemplate = result.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
    expect(oauthTemplate?.kind === "oauth2" ? oauthTemplate.scopes : undefined).toEqual([
      pickerScope,
    ]);

    const spec = decodeConvertedSpec(result.specText);
    const operation = spec.paths["/mediaItems"]?.get;
    expect(operation).toMatchObject({
      operationId: "mediaItems.list",
      "x-google-scopes": [pickerScope],
      security: [{ googleOAuth2: [pickerScope] }],
    });
  }),
);

it.effect(
  "generates a separate media-upload operation for Google Discovery methods with supportsMediaUpload",
  () =>
    Effect.gen(function* () {
      const result = yield* convertGoogleDiscoveryToOpenApi({
        discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        documentText: JSON.stringify({
          name: "drive",
          version: "v3",
          title: "Drive API",
          rootUrl: "https://www.googleapis.com/",
          servicePath: "drive/v3/",
          resources: {
            files: {
              methods: {
                create: {
                  id: "drive.files.create",
                  httpMethod: "POST",
                  path: "files",
                  request: { $ref: "File" },
                  response: { $ref: "File" },
                  supportsMediaUpload: true,
                  mediaUpload: {
                    accept: ["*/*"],
                    maxSize: "5497558138880",
                    protocols: {
                      simple: {
                        multipart: true,
                        path: "/upload/drive/v3/files",
                      },
                      resumable: {
                        multipart: true,
                        path: "/resumable/upload/drive/v3/files",
                      },
                    },
                  },
                  scopes: ["https://www.googleapis.com/auth/drive.file"],
                  parameters: {
                    enforceSingleParent: {
                      location: "query",
                      type: "boolean",
                    },
                  },
                },
                update: {
                  id: "drive.files.update",
                  httpMethod: "PATCH",
                  path: "files/{fileId}",
                  request: { $ref: "File" },
                  response: { $ref: "File" },
                  supportsMediaUpload: true,
                  mediaUpload: {
                    accept: ["*/*"],
                    protocols: {
                      simple: {
                        multipart: true,
                        path: "/upload/drive/v3/files/{fileId}",
                      },
                    },
                  },
                  scopes: ["https://www.googleapis.com/auth/drive.file"],
                  parameters: {
                    fileId: {
                      location: "path",
                      required: true,
                      type: "string",
                    },
                  },
                },
                export: {
                  id: "drive.files.export",
                  httpMethod: "GET",
                  path: "files/{fileId}/export",
                  supportsMediaDownload: true,
                  useMediaDownloadService: true,
                  parameters: {
                    fileId: {
                      location: "path",
                      required: true,
                      type: "string",
                    },
                    mimeType: {
                      location: "query",
                      required: true,
                      type: "string",
                    },
                  },
                },
              },
            },
          },
          schemas: {
            File: {
              id: "File",
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        }),
      });

      const spec = decodeConvertedSpec(result.specText);
      // The metadata-only operation should keep the original JSON behavior.
      const createMetadata = spec.paths["/files"]?.post;
      expect(createMetadata).toMatchObject({
        operationId: "files.create",
        "x-executor-toolPath": "files.create",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/File" },
            },
          },
        },
      });

      // A separate media-upload operation should be emitted with the simple upload path.
      const createMedia = spec.paths["/upload/drive/v3/files"]?.post;
      expect(createMedia).toMatchObject({
        operationId: "files.createMedia",
        "x-executor-toolPath": "files.createMedia",
        "x-executor-pathTemplate": "/upload/drive/v3/files",
      });
      expect(createMedia?.parameters).toContainEqual(
        expect.objectContaining({
          name: "uploadType",
          in: "query",
          required: true,
          schema: {
            type: "string",
            description: "The upload type for the media upload.",
            enum: ["media"],
            default: "media",
          },
        }),
      );
      expect(createMedia?.requestBody).toMatchObject({
        content: {
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        },
      });

      // The updateMedia operation should preserve path parameters from the original method.
      const updateMedia = spec.paths["/upload/drive/v3/files/{fileId}"]?.patch;
      expect(updateMedia).toMatchObject({
        operationId: "files.updateMedia",
        "x-executor-toolPath": "files.updateMedia",
        "x-executor-pathTemplate": "/upload/drive/v3/files/{fileId}",
      });
      expect(updateMedia?.parameters).toContainEqual(
        expect.objectContaining({
          name: "fileId",
          in: "path",
          required: true,
        }),
      );
      expect(updateMedia?.parameters).toContainEqual(
        expect.objectContaining({
          name: "uploadType",
          in: "query",
          required: true,
          schema: {
            type: "string",
            description: "The upload type for the media upload.",
            enum: ["media"],
            default: "media",
          },
        }),
      );

      // Extraction should produce a usable input schema that includes bodyBase64.
      const parsed = yield* parse(result.specText);
      const extracted = yield* extract(parsed);
      const createMediaOp = extracted.operations.find(
        (candidate) => candidate.operationId === "files.createMedia",
      );
      expect(createMediaOp?.operationId).toBe("files.createMedia");
      const inputSchema = createMediaOp
        ? (Option.getOrUndefined(createMediaOp.inputSchema) as
            | {
                properties?: Record<string, unknown>;
                required?: string[];
              }
            | undefined)
        : undefined;
      expect(inputSchema).toBeDefined();
      expect(inputSchema?.properties?.bodyBase64).toMatchObject({
        type: "string",
        contentEncoding: "base64",
        contentMediaType: "application/octet-stream",
      });
      expect(inputSchema?.required).toContain("bodyBase64");
      expect(inputSchema?.properties?.body).toBeUndefined();
    }),
);

it.effect("bundles Google Discovery documents into one Google OpenAPI integration", () =>
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
    expect(extractedGmail?.servers[0]?.url).toBe("https://gmail.googleapis.com/");
    expect(extractedChatMessage?.pathTemplate).toBe("/v1/{+name}");
    expect(extractedChatMessage?.servers[0]?.url).toBe("https://chat.googleapis.com/");
    // v2: the bundled oauth scopes are carried on the oauth auth template.
    const oauthTemplate = result.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
    expect(oauthTemplate?.kind === "oauth2" ? oauthTemplate.scopes : undefined).toEqual([
      "openid",
      "email",
      "profile",
      ...googleOAuthConsentScopesForPreset("google-gmail"),
      ...googleOAuthConsentScopesForPreset("google-chat"),
    ]);
  }),
);

it.effect("filters Gmail operations to the explicitly selected consent scope", () =>
  Effect.gen(function* () {
    const modifyScope = "https://www.googleapis.com/auth/gmail.modify";
    const fullScope = "https://mail.google.com/";
    const result = yield* convertGoogleDiscoveryBundleToOpenApi({
      consentScopes: [modifyScope],
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
                  [modifyScope]: { description: "Read and modify Gmail" },
                  [fullScope]: { description: "Full Gmail access" },
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
                        scopes: [modifyScope, fullScope],
                        parameters: {
                          userId: {
                            location: "path",
                            required: true,
                            type: "string",
                          },
                        },
                      },
                      delete: {
                        id: "gmail.users.messages.delete",
                        httpMethod: "DELETE",
                        path: "gmail/v1/users/{userId}/messages/{id}",
                        scopes: [fullScope],
                        parameters: {
                          userId: {
                            location: "path",
                            required: true,
                            type: "string",
                          },
                          id: {
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
            schemas: {},
          }),
        },
      ],
    });

    const spec = decodeConvertedSpec(result.specText);
    const operationIds = Object.values(spec.paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId),
    );
    expect(operationIds).toContain("gmail.users.messages.list");
    expect(operationIds).not.toContain("gmail.users.messages.delete");
    const oauthTemplate = result.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
    expect(oauthTemplate?.kind === "oauth2" ? oauthTemplate.scopes : undefined).toEqual([
      modifyScope,
    ]);
  }),
);

it.effect("keeps consumer Gmail settings tools alongside full mailbox access", () =>
  Effect.gen(function* () {
    const fullScope = "https://mail.google.com/";
    const settingsBasicScope = "https://www.googleapis.com/auth/gmail.settings.basic";
    const settingsSharingScope = "https://www.googleapis.com/auth/gmail.settings.sharing";
    const result = yield* convertGoogleDiscoveryBundleToOpenApi({
      consentScopes: [fullScope, settingsBasicScope],
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
                  [fullScope]: { description: "Full Gmail access" },
                  [settingsBasicScope]: {
                    description: "Manage Gmail settings",
                  },
                  [settingsSharingScope]: {
                    description: "Manage Gmail sharing settings",
                  },
                },
              },
            },
            resources: {
              users: {
                resources: {
                  messages: {
                    methods: {
                      delete: {
                        id: "gmail.users.messages.delete",
                        httpMethod: "DELETE",
                        path: "gmail/v1/users/{userId}/messages/{id}",
                        scopes: [fullScope],
                        parameters: {
                          userId: {
                            location: "path",
                            required: true,
                            type: "string",
                          },
                          id: {
                            location: "path",
                            required: true,
                            type: "string",
                          },
                        },
                      },
                    },
                  },
                  settings: {
                    resources: {
                      filters: {
                        methods: {
                          create: {
                            id: "gmail.users.settings.filters.create",
                            httpMethod: "POST",
                            path: "gmail/v1/users/{userId}/settings/filters",
                            scopes: [settingsBasicScope],
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
                      forwardingAddresses: {
                        methods: {
                          create: {
                            id: "gmail.users.settings.forwardingAddresses.create",
                            httpMethod: "POST",
                            path: "gmail/v1/users/{userId}/settings/forwardingAddresses",
                            scopes: [settingsSharingScope],
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
              },
            },
            schemas: {},
          }),
        },
      ],
    });

    const spec = decodeConvertedSpec(result.specText);
    const operationIds = Object.values(spec.paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId),
    );
    expect(operationIds).toContain("gmail.users.messages.delete");
    expect(operationIds).toContain("gmail.users.settings.filters.create");
    expect(operationIds).not.toContain("gmail.users.settings.forwardingAddresses.create");
    const oauthTemplate = result.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
    expect(oauthTemplate?.kind === "oauth2" ? oauthTemplate.scopes : undefined).toEqual([
      fullScope,
      settingsBasicScope,
    ]);
  }),
);

// ---------------------------------------------------------------------------
// The merged bundle scope set is the COMPACTED + FILTERED union: sub-scopes
// collapse under their broad parent (Gmail message scopes → `mail.google.com/`,
// `calendar.*` → `calendar`, `userinfo.email` → `email`), and scopes a user
// OAuth consent screen can't show (`chat.bot`, `chat.app.*`, `keep`) are
// dropped. The persisted auth template, the spec `securitySchemes.googleOAuth2`
// flow scopes, and the root `security` entry all agree - so the preview the
// picker shows and the set `oauth.start` requests at connect are the same.
// Per-operation `x-google-scopes`/`security` stay RAW (they describe per-method
// scope needs, not consent).
// ---------------------------------------------------------------------------

const ConvertedSpecSecurity = Schema.Struct({
  components: Schema.Struct({
    securitySchemes: Schema.Record(
      Schema.String,
      Schema.Struct({
        type: Schema.String,
        flows: Schema.Struct({
          authorizationCode: Schema.Struct({
            scopes: Schema.Record(Schema.String, Schema.String),
          }),
        }),
      }),
    ),
  }),
  security: Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  paths: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Struct({ "x-google-scopes": Schema.Array(Schema.String) })),
  ),
});
const decodeConvertedSpecSecurity = Schema.decodeUnknownSync(
  Schema.fromJsonString(ConvertedSpecSecurity),
);

it.effect("generates media-upload operations for bundled Google Discovery documents", () =>
  Effect.gen(function* () {
    const result = yield* convertGoogleDiscoveryBundleToOpenApi({
      documents: [
        {
          discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          documentText: JSON.stringify({
            name: "drive",
            version: "v3",
            title: "Drive API",
            rootUrl: "https://www.googleapis.com/",
            servicePath: "drive/v3/",
            auth: {
              oauth2: {
                scopes: {
                  "https://www.googleapis.com/auth/drive.file": {
                    description: "Drive file access",
                  },
                },
              },
            },
            resources: {
              files: {
                methods: {
                  create: {
                    id: "drive.files.create",
                    httpMethod: "POST",
                    path: "files",
                    request: { $ref: "File" },
                    response: { $ref: "File" },
                    supportsMediaUpload: true,
                    mediaUpload: {
                      accept: ["*/*"],
                      protocols: {
                        simple: {
                          multipart: true,
                          path: "/upload/drive/v3/files",
                        },
                      },
                    },
                    scopes: ["https://www.googleapis.com/auth/drive.file"],
                    parameters: {},
                  },
                },
              },
            },
            schemas: {
              File: {
                id: "File",
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
    const createMedia = spec.paths["/upload/drive/v3/files"]?.post;
    expect(createMedia).toMatchObject({
      operationId: "drive.files.createMedia",
      "x-executor-toolPath": "drive.files.createMedia",
      "x-executor-pathTemplate": "/upload/drive/v3/files",
    });
    expect(createMedia?.parameters).toContainEqual(
      expect.objectContaining({
        name: "uploadType",
        in: "query",
        required: true,
      }),
    );
    expect(createMedia?.requestBody).toMatchObject({
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      },
    });
  }),
);

it.effect("compacts and filters the merged bundle scope set into a clean consent set", () =>
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
                  // Broad parent + a sub-scope that must collapse under it.
                  "https://mail.google.com/": {
                    description: "Full Gmail access",
                  },
                  "https://www.googleapis.com/auth/gmail.readonly": {
                    description: "Read Gmail",
                  },
                  // Basic settings remain independent; admin-only sharing and
                  // contextual add-on scopes must not enter user consent.
                  "https://www.googleapis.com/auth/gmail.settings.basic": {
                    description: "Manage Gmail settings",
                  },
                  "https://www.googleapis.com/auth/gmail.settings.sharing": {
                    description: "Manage Gmail sharing settings",
                  },
                  "https://www.googleapis.com/auth/gmail.addons.current.message.readonly": {
                    description: "Read the current add-on message",
                  },
                  // Identity scope normalized to `email`.
                  "https://www.googleapis.com/auth/userinfo.email": {
                    description: "Email",
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
                        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
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
            schemas: {},
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
                  // A keepable consent scope plus two that the user-consent filter
                  // must drop (`chat.bot`, `chat.app.*`).
                  "https://www.googleapis.com/auth/chat.spaces.readonly": {
                    description: "Spaces",
                  },
                  "https://www.googleapis.com/auth/chat.bot": {
                    description: "Bot",
                  },
                  "https://www.googleapis.com/auth/chat.app.spaces": {
                    description: "App spaces",
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
                    scopes: ["https://www.googleapis.com/auth/chat.bot"],
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
            schemas: {},
          }),
        },
      ],
    });

    const expectedConsentScopes = [
      "openid",
      "email",
      "profile",
      ...googleOAuthConsentScopesForPreset("google-gmail"),
      ...googleOAuthConsentScopesForPreset("google-chat"),
    ];

    // Known services use their audited consent bundle instead of treating the
    // Discovery document's alternative scopes as a cumulative request.
    const oauthTemplate = result.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
    expect(oauthTemplate?.kind === "oauth2" ? [...oauthTemplate.scopes].sort() : undefined).toEqual(
      [...expectedConsentScopes].sort(),
    );

    const spec = decodeConvertedSpecSecurity(result.specText);
    // The spec's securitySchemes flow scopes match the consent set exactly.
    expect(
      Object.keys(spec.components.securitySchemes["googleOAuth2"]!.flows.authorizationCode.scopes)
        .slice()
        .sort(),
    ).toEqual([...expectedConsentScopes].sort());
    // The root security entry references the same compacted set.
    expect([...(spec.security[0]?.["googleOAuth2"] ?? [])].sort()).toEqual(
      [...expectedConsentScopes].sort(),
    );
    // App-auth-only methods are unavailable to the ordinary user OAuth bundle.
    expect(spec.paths["/v1/{name}"]?.get).toBeUndefined();
  }),
);

it.effect("applies public Google schema and parameter corrections", () =>
  Effect.gen(function* () {
    const result = yield* convertGoogleDiscoveryBundleToOpenApi({
      documents: [
        {
          discoveryUrl: "https://sheets.googleapis.com/$discovery/rest?version=v4",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          documentText: JSON.stringify({
            name: "sheets",
            version: "v4",
            title: "Google Sheets API",
            rootUrl: "https://sheets.googleapis.com/",
            servicePath: "",
            schemas: {
              Request: {
                type: "object",
                properties: {
                  addSheet: { type: "object" },
                  addDataSource: { type: "object" },
                  updateDataSource: { type: "object" },
                  refreshDataSource: { type: "object" },
                  cancelDataSourceRefresh: { type: "object" },
                },
              },
            },
          }),
        },
        {
          discoveryUrl: "https://photospicker.googleapis.com/$discovery/rest?version=v1",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          documentText: JSON.stringify({
            name: "photospicker",
            version: "v1",
            title: "Google Photos Picker API",
            rootUrl: "https://photospicker.googleapis.com/",
            servicePath: "",
            parameters: {
              key: { location: "query", type: "string" },
              oauth_token: { location: "query", type: "string" },
            },
            resources: {
              mediaItems: {
                methods: {
                  list: {
                    id: "photospicker.mediaItems.list",
                    httpMethod: "GET",
                    path: "v1/mediaItems",
                    parameters: {
                      sessionId: {
                        location: "query",
                        type: "string",
                        description: "Required. The picker session identifier.",
                      },
                    },
                  },
                },
              },
            },
            schemas: {
              PickingConfig: {
                type: "object",
                properties: {
                  maxItemCount: { type: "integer" },
                  showEducationBanner: { type: "boolean" },
                  showZeroState: { type: "boolean" },
                  showExpandedAppBar: { type: "boolean" },
                },
              },
            },
          }),
        },
      ],
    });

    const spec = decodeConvertedSpec(result.specText);
    const sheetsRequest = spec.components.schemas["sheets_v4_Request"] as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(sheetsRequest.properties ?? {})).toEqual(["addSheet"]);

    const pickingConfig = spec.components.schemas["photospicker_v1_PickingConfig"] as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(pickingConfig.properties ?? {})).toEqual(["maxItemCount"]);

    const pickerList = spec.paths["/v1/mediaItems"]?.get;
    expect(pickerList?.parameters).toContainEqual(
      expect.objectContaining({
        name: "sessionId",
        in: "query",
        required: true,
      }),
    );
    expect(pickerList?.parameters.map((parameter) => parameter.name)).not.toContain("key");
    expect(pickerList?.parameters.map((parameter) => parameter.name)).not.toContain("oauth_token");
  }),
);

it.effect("uses the preferred BigQuery grant for headless Discovery imports", () =>
  Effect.gen(function* () {
    const result = yield* convertGoogleDiscoveryBundleToOpenApi({
      documents: [
        {
          discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/bigquery/v2/rest",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          documentText: JSON.stringify({
            name: "bigquery",
            version: "v2",
            title: "BigQuery API",
            rootUrl: "https://bigquery.googleapis.com/",
            servicePath: "bigquery/v2/",
            auth: {
              oauth2: {
                scopes: {
                  "https://www.googleapis.com/auth/bigquery": {
                    description: "BigQuery",
                  },
                  "https://www.googleapis.com/auth/cloud-platform": {
                    description: "Cloud",
                  },
                  "https://www.googleapis.com/auth/devstorage.read_write": {
                    description: "Storage",
                  },
                },
              },
            },
            schemas: {},
          }),
        },
      ],
    });

    const oauthTemplate = result.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
    expect(oauthTemplate?.kind === "oauth2" ? oauthTemplate.scopes : undefined).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/bigquery",
    ]);
  }),
);

it.effect("marks People API semantic inputs as required", () =>
  Effect.gen(function* () {
    const result = yield* convertGoogleDiscoveryBundleToOpenApi({
      documents: [
        {
          discoveryUrl: "https://people.googleapis.com/$discovery/rest?version=v1",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          documentText: JSON.stringify({
            name: "people",
            version: "v1",
            title: "People API",
            rootUrl: "https://people.googleapis.com/",
            servicePath: "",
            auth: {
              oauth2: {
                scopes: {
                  "https://www.googleapis.com/auth/contacts": { description: "Contacts" },
                },
              },
            },
            resources: {
              people: {
                methods: {
                  get: {
                    id: "people.people.get",
                    httpMethod: "GET",
                    path: "v1/{+resourceName}",
                    scopes: ["https://www.googleapis.com/auth/contacts"],
                    parameters: {
                      resourceName: { location: "path", required: true, type: "string" },
                      personFields: { location: "query", type: "string" },
                    },
                  },
                  batchCreateContacts: {
                    id: "people.people.batchCreateContacts",
                    httpMethod: "POST",
                    path: "v1/people:batchCreateContacts",
                    scopes: ["https://www.googleapis.com/auth/contacts"],
                    request: { $ref: "BatchCreateContactsRequest" },
                  },
                },
              },
            },
            schemas: {
              BatchCreateContactsRequest: {
                type: "object",
                properties: {
                  contacts: { type: "array", items: { type: "object" } },
                  readMask: { type: "string" },
                },
              },
            },
          }),
        },
      ],
    });

    const spec = decodeConvertedSpec(result.specText);
    expect(spec.paths["/v1/{resourceName}"]?.get?.parameters).toContainEqual(
      expect.objectContaining({ name: "personFields", required: true }),
    );

    const batchCreate = spec.paths["/v1/people:batchCreateContacts"]?.post;
    expect(batchCreate?.requestBody).toMatchObject({ required: true });
    expect(spec.components.schemas["people_v1_BatchCreateContactsRequest"]).toMatchObject({
      required: ["contacts", "readMask"],
    });
  }),
);

it("falls back to the service-hosted Discovery URL when the central directory has no entry", async () => {
  // Google Ads is not listed in the central directory: normalization maps it
  // onto www.googleapis.com for identity, and that URL 404s. The fetch must
  // still succeed by falling back to the host the caller named.
  const seen: string[] = [];
  const stub = HttpClient.make((request) => {
    seen.push(request.url);
    return Effect.succeed(
      request.url.includes("www.googleapis.com")
        ? HttpClientResponse.fromWeb(request, new Response("nope", { status: 404 }))
        : HttpClientResponse.fromWeb(
            request,
            new Response('{"name":"googleads"}', { status: 200 }),
          ),
    );
  });
  const text = await Effect.runPromise(
    fetchGoogleDiscoveryDocument(
      "https://googleads.googleapis.com/$discovery/rest?version=v24",
    ).pipe(Effect.provideService(HttpClient.HttpClient, stub)),
  );
  expect(text).toBe('{"name":"googleads"}');
  expect(seen[0]).toContain("www.googleapis.com");
  expect(seen[1]).toBe("https://googleads.googleapis.com/$discovery/rest?version=v24");
});
