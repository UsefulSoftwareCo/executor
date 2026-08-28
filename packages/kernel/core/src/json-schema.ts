import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import type { StandardSchema } from "./types";
import { unknownInputSchema } from "./types";

// Built on first use, not at import. Two reasons, and the second is the one
// that matters beyond this file:
//
//   1. Constructing an Ajv instance and registering every format is real work,
//      and it ran on each cold isolate that so much as imported this package —
//      including the many that never validate a schema.
//   2. `new Ajv2020(...)` + `addFormats(...)` at module scope are import-time
//      side effects, so a bundler must keep this module (and therefore ajv)
//      whenever anything touches the package barrel. `packages/core/execution`
//      imports exactly one runtime value from it — `CodeExecutionError` — and
//      the rest as erased types, yet still dragged ajv AND sucrase into the
//      server graph. With no module-scope effects left here, `sideEffects:
//      false` in package.json is honest and the unused modules tree-shake out.
let ajvInstance: Ajv2020 | undefined;

const getAjv = (): Ajv2020 => {
  if (ajvInstance === undefined) {
    ajvInstance = new Ajv2020({
      allErrors: true,
      strict: false,
      validateSchema: false,
      allowUnionTypes: true,
    });
    addFormats(ajvInstance);
  }
  return ajvInstance;
};

const decodePointerSegment = (segment: string): PropertyKey => {
  const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
  return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
};

const pointerToPath = (pointer: string | undefined): ReadonlyArray<PropertyKey> | undefined => {
  if (!pointer || pointer.length === 0 || pointer === "/") {
    return undefined;
  }

  return pointer
    .split("/")
    .slice(1)
    .filter((segment) => segment.length > 0)
    .map(decodePointerSegment);
};

const toIssueMessage = (error: ErrorObject): string => {
  const keyword = error.keyword.trim();
  // oxlint-disable-next-line executor/no-unknown-error-message -- typed AJV ErrorObject exposes optional validation message copy
  const message = (error.message ?? "Invalid value").trim();
  return keyword.length > 0 ? `${keyword}: ${message}` : message;
};

export const standardSchemaFromJsonSchema = (
  schema: unknown,
  options?: {
    vendor?: string;
    fallback?: StandardSchema;
  },
): StandardSchema => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: AJV compile throws for invalid schemas and this adapter preserves fallback behavior
  try {
    const validate = getAjv().compile(schema as Record<string, unknown>);

    return {
      "~standard": {
        version: 1,
        vendor: options?.vendor ?? "json-schema",
        validate: (value: unknown) => {
          const valid = validate(value);
          if (valid) {
            return { value };
          }

          const issues = (validate.errors ?? []).map((error) => ({
            message: toIssueMessage(error),
            path: pointerToPath(error.instancePath),
          }));

          return {
            issues: issues.length > 0 ? issues : [{ message: "Invalid value" }],
          };
        },
      },
    };
  } catch {
    return options?.fallback ?? unknownInputSchema;
  }
};
