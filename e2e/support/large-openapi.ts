const words = [
  "account",
  "project",
  "deployment",
  "domain",
  "team",
  "token",
  "environment",
  "variable",
  "alias",
  "certificate",
  "integration",
  "webhook",
  "firewall",
  "member",
  "invite",
  "region",
] as const;

const word = (seed: number) => words[seed % words.length] ?? "item";
const sentence = (seed: number, length: number) => {
  let text = "";
  for (let index = 0; text.length < length; index++)
    text += `${word(seed * 31 + index * 7)}${index % 11 === 10 ? ". " : " "}`;
  return text.trim();
};

type Json = { readonly [key: string]: unknown };

const objectSchema = (seed: number, depth: number, width: number): Json => {
  const properties: Record<string, Json> = {};
  for (let index = 0; index < width; index++) {
    const description = sentence(seed + index, 116);
    const kind = (seed + index) % 5;
    properties[`${word(seed + index)}${index}`] =
      depth > 0 && kind === 0
        ? { ...objectSchema(seed * 3 + index, depth - 1, Math.max(2, width - 2)), description }
        : kind === 1
          ? { type: "string", enum: words.slice(0, 6 + (index % 8)), description }
          : kind === 2
            ? { type: "array", items: { type: "string" }, description }
            : kind === 3
              ? { type: "integer", minimum: 0, example: 42, description }
              : { type: "string", nullable: true, description };
  }
  return { type: "object", required: Object.keys(properties).slice(0, 2), properties };
};

export const largeOpenapiDocument = (origin: string, operations: number, prose?: string) => {
  const paths: Record<string, Record<string, Json>> = {
    "/health": {
      get: {
        operationId: "health",
        tags: ["service"],
        responses: {
          "200": {
            description: "The service is up.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  };
  const methods = ["get", "post", "patch", "delete"] as const;
  for (let index = 0; index < operations; index++) {
    const method = methods[index % methods.length] ?? "get";
    const path = `/v${1 + (index % 9)}/${word(index)}s/${Math.floor(index / 4)}/{id}`;
    paths[path] = {
      ...paths[path],
      [method]: {
        operationId: `${method}${word(index)}${index}`,
        tags: [word(index >> 2)],
        summary: sentence(index, 60),
        description:
          prose === undefined ? sentence(index + 1, 400) : `${sentence(index + 1, 400)} ${prose}`,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: sentence(index, 80),
          },
          {
            name: "teamId",
            in: "query",
            schema: { type: "string" },
            description: sentence(index + 2, 80),
          },
        ],
        ...(method === "post" || method === "patch"
          ? {
              requestBody: {
                required: true,
                content: { "application/json": { schema: objectSchema(index, 2, 9) } },
              },
            }
          : {}),
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: objectSchema(index + 5, 3, 9) } },
          },
          "400": { description: sentence(index, 40) },
        },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: "Synthetic large API", version: "1.0.0" },
    servers: [{ url: origin }],
    paths,
  };
};

export const expandableOpenapiDocument = (
  origin: string,
  resources: number,
  operations: number,
) => {
  const schemas: Record<string, Json> = {};
  for (let resource = 0; resource < resources; resource++) {
    const properties: Record<string, Json> = {
      id: { type: "string", description: sentence(resource, 80) },
    };
    for (let field = 0; field < 40; field++)
      properties[`${word(resource + field)}${field}`] =
        field % 2 === 0
          ? { type: "string", description: sentence(resource * 41 + field, 200) }
          : { type: "integer", minimum: 0, description: sentence(resource * 43 + field, 200) };
    const next = `resource${(resource + 1) % resources}`;
    properties[next] = {
      description: `The ${next} this resource belongs to: its ID, or the ${next} when expanded.`,
      anyOf: [{ type: "string", maxLength: 5000 }, { $ref: `#/components/schemas/${next}` }],
    };
    schemas[`resource${resource}`] = { type: "object", required: ["id"], properties };
  }
  const paths: Record<string, Record<string, Json>> = {
    "/health": {
      get: {
        operationId: "health",
        tags: ["service"],
        responses: {
          "200": {
            description: "The service is up.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  };
  for (let index = 0; index < operations; index++) {
    const resource = index % resources;
    const view = Math.floor(index / resources);
    paths[`/v1/resource${resource}/views/${view}/{id}`] = {
      get: {
        operationId: `getResource${resource}View${view}`,
        tags: ["resources"],
        summary: sentence(index, 60),
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/resource${resource}` },
              },
            },
          },
        },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: "Synthetic expandable API", version: "1.0.0" },
    servers: [{ url: origin }],
    paths,
    components: { schemas },
  };
};
