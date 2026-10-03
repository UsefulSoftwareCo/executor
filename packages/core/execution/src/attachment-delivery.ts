import { Effect } from "effect";
import { isToolFile } from "@executor-js/sdk";
import type { ExecuteResult, SandboxToolInvoker } from "@executor-js/codemode-core";

type Output = NonNullable<ExecuteResult["output"]>[number];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Keep attachment bytes on the host and expose metadata in the result preview. */
export const withAttachmentDelivery = (invoker: SandboxToolInvoker) => {
  const attachments: Output[] = [];
  const seen = new Set<string>();

  const capture = (value: unknown, deliver: boolean): unknown => {
    if (isToolFile(value)) {
      const key = `${value.mimeType}:${value.data}`;
      if (deliver && !seen.has(key)) {
        seen.add(key);
        attachments.push({ type: "file", file: value });
      }
      return {
        name: value.name,
        mimeType: value.mimeType,
        byteLength: value.byteLength,
        delivery: deliver ? "attachment" : "omitted",
      };
    }
    if (Array.isArray(value)) return value.map((item) => capture(item, deliver));
    if (!isRecord(value)) return value;
    // Failed calls must never deliver attachments, including nested MCP errors.
    deliver = deliver && value.ok !== false && value.isError !== true;

    const binary =
      (value.type === "image" || value.type === "audio") &&
      typeof value.data === "string" &&
      typeof value.mimeType === "string"
        ? { mimeType: value.mimeType, data: value.data }
        : value.type === "resource" &&
            isRecord(value.resource) &&
            typeof value.resource.blob === "string"
          ? {
              mimeType: value.resource.mimeType,
              data: value.resource.blob,
              uri: value.resource.uri,
            }
          : undefined;
    if (binary) {
      const key = `${binary.mimeType}:${binary.data}`;
      if (deliver && !seen.has(key)) {
        seen.add(key);
        attachments.push({ type: "content", content: value });
      }
      return {
        type: "text",
        text: JSON.stringify({
          delivery: deliver ? "attachment" : "omitted",
          mimeType: binary.mimeType,
          uri: binary.uri,
        }),
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, capture(item, deliver)]),
    );
  };

  return {
    invoker: {
      invoke: (input) =>
        invoker.invoke(input).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              capture(value, true);
            }),
          ),
        ),
    } satisfies SandboxToolInvoker,
    finish: (result: ExecuteResult): ExecuteResult => {
      // Returning a file or native block directly also delivers it. Explicit emit
      // remains supported; match its bytes to avoid sending the attachment twice.
      const compactResult = capture(result.result, true);
      const key = (output: Output): string | undefined => {
        const value = output.type === "file" ? output.file : output.content;
        if (isToolFile(value)) return `${value.mimeType}:${value.data}`;
        if (!isRecord(value)) return undefined;
        if ((value.type === "image" || value.type === "audio") && typeof value.data === "string")
          return `${value.mimeType}:${value.data}`;
        if (
          value.type === "resource" &&
          isRecord(value.resource) &&
          typeof value.resource.blob === "string"
        )
          return `${value.resource.mimeType}:${value.resource.blob}`;
        return undefined;
      };
      const explicitKeys = new Set<string>();
      const explicit = (result.output ?? []).filter((item) => {
        const identity = key(item);
        if (identity === undefined) return true;
        if (explicitKeys.has(identity)) return false;
        explicitKeys.add(identity);
        return true;
      });
      const output = [...attachments.filter((item) => !explicitKeys.has(key(item)!)), ...explicit];
      return { ...result, result: compactResult, ...(output.length ? { output } : {}) };
    },
  };
};
