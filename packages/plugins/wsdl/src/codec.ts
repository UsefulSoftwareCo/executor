import { Effect, Predicate } from "effect";
import type { ElementShape } from "./contract";
import {
  children,
  ENVELOPE,
  escapeXml,
  key,
  one,
  parseXml,
  WsdlError,
  XSI,
  type XmlNode,
} from "./xml";

export const jsonSchema = (shape: ElementShape): Record<string, unknown> => {
  const value: Record<string, unknown> =
    shape.kind === "object"
      ? {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            shape.fields.map((field) => [field.name, jsonSchema(field)]),
          ),
          required: shape.fields.filter((field) => field.min > 0).map((field) => field.name),
        }
      : shape.kind === "int"
        ? { type: "integer", minimum: -2147483648, maximum: 2147483647 }
        : shape.kind === "boolean"
          ? { type: "boolean" }
          : {
              type: "string",
              ...(shape.kind === "integer"
                ? { pattern: "^[+-]?[0-9]+$" }
                : shape.kind === "decimal"
                  ? { pattern: "^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)$" }
                  : {}),
            };
  const nullable = shape.nullable ? { anyOf: [value, { type: "null" }] } : value;
  return shape.max > 1
    ? { type: "array", items: nullable, minItems: shape.min, maxItems: shape.max }
    : nullable;
};

const scalar = (shape: ElementShape, value: unknown): Effect.Effect<string, WsdlError> =>
  Effect.gen(function* () {
    if (shape.kind === "boolean" && typeof value === "boolean") return value ? "true" : "false";
    if (
      shape.kind === "int" &&
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= -2147483648 &&
      value <= 2147483647
    )
      return String(value);
    if (typeof value === "string") {
      if (
        shape.kind === "string" &&
        [...value].every((character) => {
          const code = character.codePointAt(0)!;
          return (
            code === 9 ||
            code === 10 ||
            code === 13 ||
            (code >= 0x20 && code <= 0xd7ff) ||
            (code >= 0xe000 && code <= 0xfffd) ||
            code >= 0x10000
          );
        })
      )
        return value;
      if (shape.kind === "integer" && /^[+-]?\d+$/.test(value)) return value;
      if (shape.kind === "decimal" && /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value)) return value;
    }
    return yield* new WsdlError({ message: `Invalid ${shape.kind} value for ${shape.name}` });
  });

export const encodeElement = (
  shape: ElementShape,
  value: unknown,
): Effect.Effect<string, WsdlError> =>
  Effect.gen(function* () {
    if (value === undefined && shape.min === 0) return "";
    if (shape.max > 1) {
      if (!Array.isArray(value) || value.length < shape.min || value.length > shape.max)
        return yield* new WsdlError({ message: `Invalid array cardinality for ${shape.name}` });
      return (yield* Effect.forEach(value, (item) =>
        encodeElement({ ...shape, min: 1, max: 1 }, item),
      )).join("");
    }
    if (value === undefined && shape.min === 0) return "";
    if (shape.max === 0)
      return yield* new WsdlError({ message: `Element ${shape.name} is prohibited` });
    const start = `<${shape.name} xmlns="${escapeXml(shape.ns)}"`;
    if (value === null && shape.nullable) return `${start} xmlns:xsi="${XSI}" xsi:nil="true"/>`;
    let content: string;
    if (shape.kind === "object") {
      if (
        !Predicate.isObject(value) ||
        Object.keys(value).some((name) => !shape.fields.some((field) => field.name === name))
      )
        return yield* new WsdlError({
          message: `Invalid object or unexpected fields for ${shape.name}`,
        });
      content = (yield* Effect.forEach(shape.fields, (field) =>
        encodeElement(field, value[field.name]),
      )).join("");
    } else content = escapeXml(yield* scalar(shape, value));
    return `${start}>${content}</${shape.name}>`;
  });

const decodeElement = (shape: ElementShape, node: XmlNode): Effect.Effect<unknown, WsdlError> =>
  Effect.gen(function* () {
    if (node.ns !== shape.ns || node.name !== shape.name)
      return yield* new WsdlError({
        message: `Unexpected response element; expected {${shape.ns}}${shape.name}`,
      });
    for (const attr of Object.keys(node.attrs))
      if (!attr.startsWith("{http://www.w3.org/2000/xmlns/}") && attr !== key(XSI, "nil"))
        return yield* new WsdlError({ message: `Unsupported response attribute ${attr}` });
    const nil = node.attrs[key(XSI, "nil")];
    if (nil && !["true", "false", "1", "0"].includes(nil))
      return yield* new WsdlError({ message: "Invalid xsi:nil" });
    if (nil === "true" || nil === "1") {
      if (!shape.nullable || node.children.length || node.text.length)
        return yield* new WsdlError({ message: "Invalid nil response element" });
      return null;
    }
    if (shape.kind === "object") {
      if (node.text.trim())
        return yield* new WsdlError({ message: "Mixed response content is unsupported" });
      const result: Record<string, unknown> = Object.create(null);
      let offset = 0;
      for (const field of shape.fields) {
        const values: unknown[] = [];
        while (
          offset < node.children.length &&
          node.children[offset]!.name === field.name &&
          node.children[offset]!.ns === field.ns
        ) {
          values.push(yield* decodeElement(field, node.children[offset++]!));
        }
        if (values.length < field.min || values.length > field.max)
          return yield* new WsdlError({
            message: `Invalid response cardinality for ${field.name}`,
          });
        if (field.max > 1) result[field.name] = values;
        else if (values.length) result[field.name] = values[0];
      }
      if (offset !== node.children.length)
        return yield* new WsdlError({ message: "Unexpected or out-of-order response elements" });
      return result;
    }
    if (node.children.length)
      return yield* new WsdlError({ message: "Unexpected children in scalar response" });
    const text = shape.kind === "string" ? node.text : node.text.trim();
    const value =
      shape.kind === "boolean"
        ? text === "true" || text === "1"
          ? true
          : text === "false" || text === "0"
            ? false
            : text
        : shape.kind === "int" && /^[+-]?\d+$/.test(text)
          ? Number(text)
          : text;
    yield* scalar(shape, value);
    return value;
  });

export const decodeEnvelope = (shape: ElementShape, xml: string) =>
  Effect.gen(function* () {
    const root = yield* parseXml(xml);
    if (root.ns !== ENVELOPE || root.name !== "Envelope")
      return yield* new WsdlError({ message: "Expected SOAP 1.1 Envelope" });
    for (const header of children(root, ENVELOPE, "Header"))
      for (const item of header.children)
        if (["1", "true"].includes(item.attrs[key(ENVELOPE, "mustUnderstand")] ?? ""))
          return yield* new WsdlError({ message: "Unsupported mandatory SOAP header" });
    if (
      root.text.trim() ||
      root.children.some(
        (node) => node.ns !== ENVELOPE || !["Header", "Body"].includes(node.name),
      ) ||
      children(root, ENVELOPE, "Header").length > 1 ||
      root.children.at(-1)?.name !== "Body"
    )
      return yield* new WsdlError({ message: "Invalid SOAP envelope structure" });
    const body = yield* one(root, ENVELOPE, "Body");
    if (body.text.trim()) return yield* new WsdlError({ message: "Unexpected SOAP body text" });
    if (body.children.length !== 1)
      return yield* new WsdlError({ message: "Expected one SOAP body element" });
    const payload = body.children[0]!;
    if (payload.ns === ENVELOPE && payload.name === "Fault") {
      const code = yield* one(payload, "", "faultcode");
      const reason = yield* one(payload, "", "faultstring");
      return { ok: false as const, fault: { code: code.text, message: reason.text } };
    }
    return { ok: true as const, value: yield* decodeElement(shape, payload) };
  });
