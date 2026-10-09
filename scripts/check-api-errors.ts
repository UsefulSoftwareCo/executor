/**
 * Agents reach Executor's own API through the Executor app, an OpenAPI import of the product's
 * document. The importer keeps an error response only when its schema is a tagged error with a
 * string `message` or a static description; any other error reaches the agent as an unexplained
 * HTTP status. This check runs the importer's own error extraction over every product document
 * and fails on each error response it would not keep, so a new endpoint or error cannot drift.
 */
import { Option, Schema } from "effect";
import { executorCloudApiDocument } from "../apps/hosted/cloud/src/contracts/api.ts";
import { executorSelfHostApiDocument } from "../apps/hosted/self-host/src/contracts/api.ts";
import { localManagementDocument } from "../apps/local/server/src/contracts/management.ts";
import { JsonObject } from "../packages/apps/src/contracts/schema.ts";
import { Operation } from "../packages/apps/src/contracts/openapi-document.ts";
import { errorResponses } from "../packages/apps/src/implementation/openapi-compile.ts";
import {
  openApiDocument,
  pointerToken,
  type OpenApiDocument,
} from "../packages/apps/src/implementation/openapi-document.ts";

const origin = "https://executor.invalid";
const documents = {
  cloud: () => executorCloudApiDocument(origin),
  "self-host": () => executorSelfHostApiDocument(origin),
  local: () => localManagementDocument(),
};
const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const object = Schema.decodeUnknownSync(JsonObject);
const optionalObject = Schema.decodeUnknownOption(JsonObject);

/** Every tag a JSON error response can carry, following references and anyOf alternatives. */
const responseTags = (document: OpenApiDocument, response: JsonObject): Array<string | null> => {
  const content = Option.getOrElse(optionalObject(document.resolve(response).content), () => ({}));
  const media = Object.entries(content).find(([type]) =>
    /^application\/(?:[\w.-]+\+)?json$/i.test(type.split(";")[0]?.trim() ?? ""),
  );
  if (media === undefined) return [null];
  const tags = (value: unknown): Array<string | null> => {
    const shape = document.resolve(object(value));
    if (Array.isArray(shape.anyOf)) return shape.anyOf.flatMap(tags);
    const tag = optionalObject(shape.properties).pipe(
      Option.flatMap((properties) => optionalObject(properties._tag)),
      Option.map((tag) => tag.const ?? (Array.isArray(tag.enum) ? tag.enum[0] : undefined)),
      Option.getOrUndefined,
    );
    return [typeof tag === "string" ? tag : null];
  };
  return tags(object(media[1]).schema);
};

/** Each dropped error, with the product operations that return it. */
const failures = new Map<string, Set<string>>();
for (const [product, generate] of Object.entries(documents)) {
  // The importer upgrades the document in place, so it receives its own copy.
  const document = await openApiDocument(object(JSON.parse(JSON.stringify(generate()))));
  for (const [route, item] of Object.entries(document.spec.paths)) {
    const path = document.resolve(object(item));
    // The importer's pointer for each operation: where its Path Item is declared, then the method.
    const pathAt = document.origin(item) ?? `#/paths/${pointerToken(route)}`;
    for (const method of methods) {
      if (path[method] === undefined) continue;
      const resolved = document.resolve(object(path[method]));
      const operation = Schema.decodeUnknownSync(Operation)(resolved);
      const kept = new Set(
        errorResponses(document, resolved, `${pathAt}/${method}`).map(
          ({ status, code }) => `${status} ${code}`,
        ),
      );
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (!/^[45]\d\d$/.test(status)) continue;
        for (const tag of responseTags(document, response))
          if (tag === null || !kept.has(`${status} ${tag}`)) {
            const key = `${tag ?? "An untagged error"} (HTTP ${status})`;
            const operations = failures.get(key) ?? new Set();
            failures.set(key, operations.add(`${product} ${operation.operationId ?? method}`));
          }
      }
    }
  }
}

if (failures.size > 0) {
  console.error(
    "These API errors reach agents without a message. Define them with ApiError or UserFacingError:",
  );
  for (const [error, operations] of [...failures].sort(([a], [b]) => a.localeCompare(b))) {
    const [first, ...rest] = operations;
    console.error(`  ${error}: ${first}${rest.length === 0 ? "" : ` and ${rest.length} more`}`);
  }
  process.exit(1);
}
console.log("Every product API error declares a message.");
