import type { OpenAPI, OpenAPIV3 } from "openapi-types";

/**
 * Checks if the given document is a Google Discovery document.
 */
export function isGoogleDiscovery(doc: any): boolean {
  return (
    typeof doc === "object" &&
    doc !== null &&
    typeof doc.discoveryVersion === "string" &&
    typeof doc.rootUrl === "string"
  );
}

/**
 * Converts a Google Discovery document to an OpenAPI V3 document.
 */
export function convertGoogleDiscoveryToOpenApi(doc: any): OpenAPIV3.Document {
  const rootUrl = doc.rootUrl || "";
  const servicePath = doc.servicePath || "";
  const baseUrl = rootUrl + servicePath;

  const openapi: OpenAPIV3.Document = {
    openapi: "3.0.3",
    info: {
      title: doc.title || doc.name || "Google Discovery API",
      version: doc.version || "1.0.0",
      description: doc.description,
    },
    servers: [
      {
        url: baseUrl,
      },
    ],
    paths: {},
    components: {
      schemas: {},
    },
  };

  // 1. Convert schemas
  if (doc.schemas) {
    for (const [name, schema] of Object.entries(doc.schemas) as [string, any][]) {
      openapi.components!.schemas![name] = convertSchema(schema);
    }
  }

  // 2. Extract scopes
  const authScopes = doc.auth?.oauth2?.scopes || {};
  if (Object.keys(authScopes).length > 0) {
    openapi.components!.securitySchemes = {
      oauth2: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
            tokenUrl: "https://oauth2.googleapis.com/token",
            scopes: Object.fromEntries(
              Object.entries(authScopes).map(([scope, meta]: [string, any]) => [
                scope,
                meta.description || scope,
              ])
            ),
          },
        },
      },
    };
    // Default global security
    openapi.security = [{ oauth2: Object.keys(authScopes) }];
  }

  // 3. Process all methods recursively
  const extractMethods = (resources: any, parentParams: any = {}) => {
    if (!resources) return;

    for (const [resourceName, resource] of Object.entries(resources) as [string, any][]) {
      const resourceParams = { ...parentParams, ...(resource.methods?.parameters || {}) };

      if (resource.methods) {
        for (const [methodName, method] of Object.entries(resource.methods) as [string, any][]) {
          addMethodToPaths(method, methodName, resourceParams, openapi);
        }
      }

      if (resource.resources) {
        extractMethods(resource.resources, resourceParams);
      }
    }
  };

  // Top level methods
  if (doc.methods) {
    for (const [methodName, method] of Object.entries(doc.methods) as [string, any][]) {
      addMethodToPaths(method, methodName, doc.parameters || {}, openapi);
    }
  }

  // Nested resources
  if (doc.resources) {
    extractMethods(doc.resources, doc.parameters || {});
  }

  return openapi;
}

function addMethodToPaths(
  method: any,
  methodName: string,
  parentParams: any,
  openapi: OpenAPIV3.Document
) {
  if (!method.path || !method.httpMethod) return;

  const path = "/" + method.path.replace(/^\//, "");
  const httpMethod = method.httpMethod.toLowerCase() as OpenAPIV3.HttpMethods;

  if (!openapi.paths[path]) {
    openapi.paths[path] = {};
  }

  const operation: OpenAPIV3.OperationObject = {
    operationId: method.id || methodName,
    description: method.description,
    parameters: [],
    responses: {
      "200": {
        description: "Successful response",
      },
    },
  };

  if (method.scopes && method.scopes.length > 0) {
    operation.security = [{ oauth2: method.scopes }];
  }

  const allParams = { ...parentParams, ...(method.parameters || {}) };
  for (const [paramName, param] of Object.entries(allParams) as [string, any][]) {
    const inLocation = param.location === "path" ? "path" : param.location === "query" ? "query" : "header";
    if (!inLocation) continue;

    const parameter: OpenAPIV3.ParameterObject = {
      name: paramName,
      in: inLocation,
      required: param.required || inLocation === "path",
      description: param.description,
      schema: convertSchema(param),
    };
    operation.parameters!.push(parameter);
  }

  if (method.request && method.request.$ref) {
    operation.requestBody = {
      content: {
        "application/json": {
          schema: {
            $ref: `#/components/schemas/${method.request.$ref}`,
          },
        },
      },
    };
  }

  if (method.response && method.response.$ref) {
    operation.responses!["200"] = {
      description: "Successful response",
      content: {
        "application/json": {
          schema: {
            $ref: `#/components/schemas/${method.response.$ref}`,
          },
        },
      },
    };
  }

  openapi.paths[path]![httpMethod] = operation;
}

function convertSchema(schema: any): OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject {
  if (schema.$ref) {
    return { $ref: `#/components/schemas/${schema.$ref}` };
  }

  const result: any = {};
  if (schema.type) result.type = schema.type;
  if (schema.description) result.description = schema.description;
  if (schema.format) result.format = schema.format;
  if (schema.enum) result.enum = schema.enum;
  if (schema.default !== undefined) result.default = schema.default;
  if (schema.readOnly) result.readOnly = schema.readOnly;
  
  if (schema.type === "array" && schema.items) {
    result.items = convertSchema(schema.items);
  } else if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    result.type = "object";
    if (schema.properties) {
      result.properties = {};
      for (const [k, v] of Object.entries(schema.properties)) {
        result.properties[k] = convertSchema(v);
      }
    }
    if (schema.additionalProperties) {
      if (typeof schema.additionalProperties === "object") {
        result.additionalProperties = convertSchema(schema.additionalProperties);
      } else {
        result.additionalProperties = true;
      }
    }
  } else if (schema.type === "any") {
    // OpenAPI 3.0 doesn't have "any" type, it's just an empty schema.
    delete result.type;
  }

  return result;
}
