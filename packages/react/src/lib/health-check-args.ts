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
