/**
 * A synthetic OpenAPI document as large as the biggest vendor APIs apps import: hundreds of
 * operations with deep inline request and response schemas, every field described. All of it is
 * generated; no real API's document is used.
 */
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

/** An object schema `depth` levels deep with `width` described properties at each level. */
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

/**
 * `operations` synthetic operations on `origin`, and `GET /health`, tagged `service` with the
 * operationId `health`, which the product itself answers with `{ "status": "ok" }`. `prose`, when
 * given, ends each operation's description.
 */
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
