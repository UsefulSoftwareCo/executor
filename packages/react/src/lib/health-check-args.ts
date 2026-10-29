import { Option, Schema } from "effect";

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const formatHealthCheckArgs = (
  args: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(args ?? {}).map(([key, value]) => [
      key,
      key === "body" ? (JSON.stringify(value) ?? "") : value == null ? "" : String(value),
    ]),
  );

export const parseHealthCheckArgs = (
  draft: Readonly<Record<string, string>>,
): { readonly ok: true; readonly args: Record<string, unknown> } | { readonly ok: false } => {
  const args: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(draft)) {
    if (value.trim().length === 0) continue;
    if (name === "body") {
      const body = decodeBody(value);
      if (Option.isNone(body)) return { ok: false };
      args[name] = body.value;
    } else {
      args[name] = value.trim();
    }
  }
  return { ok: true, args };
};

// Tool arguments (MCP) are one typed JSON object, edited whole. JSON text
// keeps numbers, booleans, arrays, null, nested objects, and string
// whitespace, and decodes every key (even `__proto__`) as an own property.
const decodeArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

export const formatJsonArguments = (args: Readonly<Record<string, unknown>> | undefined): string =>
  args === undefined || Object.keys(args).length === 0 ? "" : JSON.stringify(args, null, 2);

/** Blank means no arguments; anything else must be a JSON object. */
export const parseJsonArguments = (
  text: string,
): { readonly ok: true; readonly args: Record<string, unknown> } | { readonly ok: false } => {
  if (text.trim().length === 0) return { ok: true, args: {} };
  return Option.match(decodeArguments(text), {
    onNone: () => ({ ok: false }),
    onSome: (args) => ({ ok: true, args }),
  });
};
