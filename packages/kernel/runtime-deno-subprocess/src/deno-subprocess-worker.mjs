// This script runs inside the Deno subprocess.
// It communicates with the host process via line-delimited JSON over stdin/stdout.
// All IPC messages are prefixed with @@executor-ipc@@ to distinguish from user output.

const encoder = new TextEncoder();
const IPC_PREFIX = "@@executor-ipc@@";

const pendingToolCalls = new Map();
const pendingYieldCalls = new Map();
let started = false;
let ipcNonce = "";

/** @type {string[]} */
const logs = [];
/** @type {Array<Record<string, unknown>>} */
let outputs = [];

const writeIpcMessage = (message) => {
  const payload = `${IPC_PREFIX}${JSON.stringify(message)}\n`;
  Deno.stdout.writeSync(encoder.encode(payload));
};

const recordOutput = (item) => {
  outputs.push(item);
  if (ipcNonce) {
    writeIpcMessage({ type: "output", nonce: ipcNonce, item });
  }
};

const toErrorMessage = (error) => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
};

const createToolCaller = (toolPath) => (args) =>
  new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pendingToolCalls.set(requestId, { resolve, reject });

    writeIpcMessage({
      type: "tool_call",
      nonce: ipcNonce,
      requestId,
      toolPath,
      args: args === undefined ? {} : args,
    });
  });

const builtinToolKeys = {
  "": ["search", "describe", "executor"],
  describe: ["tool"],
  executor: ["sources"],
  "executor.sources": ["list"],
};

const toolKeysForPath = (path) => builtinToolKeys[path.join(".")] ?? [];

const createToolsProxy = (path = []) => {
  const callable = () => undefined;

  return new Proxy(callable, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (typeof prop !== "string") return undefined;
      return createToolsProxy([...path, prop]);
    },
    ownKeys() {
      return toolKeysForPath(path);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return typeof prop === "string" && toolKeysForPath(path).includes(prop)
        ? { enumerable: true, configurable: true }
        : undefined;
    },
    apply(_target, _thisArg, args) {
      const toolPath = path.join(".");
      if (!toolPath) {
        throw new Error("Tool path missing in invocation");
      }

      return createToolCaller(toolPath)(args.length > 0 ? args[0] : undefined);
    },
  });
};

const formatLogArg = (value) => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const formatLogLine = (args) => args.map(formatLogArg).join(" ");

const formatOutputText = (value) => {
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const IMAGE_DETAIL_META_KEY = "codex/imageDetail";
const DEFAULT_IMAGE_DETAIL = "high";
const validImageDetails = new Set(["auto", "low", "high", "original"]);

const normalizeImageDetail = (detail) => {
  if (detail === null || typeof detail === "undefined") {
    return undefined;
  }
  if (typeof detail !== "string") {
    throw new TypeError("image detail must be a string when provided");
  }
  const normalized = detail.toLowerCase();
  if (!validImageDetails.has(normalized)) {
    throw new TypeError("image detail must be one of: auto, low, high, original");
  }
  return normalized;
};

const isToolFile = (value) =>
  value &&
  typeof value === "object" &&
  // oxlint-disable-next-line executor/no-manual-tag-check -- boundary: Deno worker validates serialized ToolFile values before host schema normalization
  value._tag === "ToolFile" &&
  typeof value.mimeType === "string" &&
  value.encoding === "base64" &&
  typeof value.data === "string" &&
  typeof value.byteLength === "number";

const isMcpTextContentBlock = (value) =>
  value && typeof value === "object" && value.type === "text" && typeof value.text === "string";

const isMcpImageContentBlock = (value) =>
  value &&
  typeof value === "object" &&
  value.type === "image" &&
  typeof value.data === "string" &&
  (typeof value.mimeType === "string" ||
    typeof value.mime_type === "string" ||
    value.data.toLowerCase().startsWith("data:"));

const isMcpAudioContentBlock = (value) =>
  value &&
  typeof value === "object" &&
  value.type === "audio" &&
  typeof value.data === "string" &&
  typeof value.mimeType === "string";

const isMcpResourceContentBlock = (value) =>
  value &&
  typeof value === "object" &&
  value.type === "resource" &&
  value.resource &&
  typeof value.resource === "object" &&
  typeof value.resource.uri === "string" &&
  (typeof value.resource.text === "string" || typeof value.resource.blob === "string");

const isMcpResourceLinkContentBlock = (value) =>
  value &&
  typeof value === "object" &&
  value.type === "resource_link" &&
  typeof value.uri === "string" &&
  typeof value.name === "string";

const isMcpContentBlock = (value) =>
  isMcpTextContentBlock(value) ||
  isMcpImageContentBlock(value) ||
  isMcpAudioContentBlock(value) ||
  isMcpResourceContentBlock(value) ||
  isMcpResourceLinkContentBlock(value);

const parseDataImageUrl = (imageUrl) => {
  if (typeof imageUrl !== "string" || imageUrl.length === 0) {
    throw new TypeError(
      "image expects a non-empty data URI, an object with image_url and optional detail, or a raw MCP image block",
    );
  }
  const lower = imageUrl.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    throw new TypeError(
      "remote image URLs are not supported in code output; pass a base64 data URI or MCP image block",
    );
  }
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(imageUrl);
  if (!match) {
    throw new TypeError("image expects a base64 data URI or MCP image block");
  }
  return { mimeType: match[1], data: match[2] };
};

const imageDetailFromMeta = (value) => {
  const meta = value && typeof value === "object" ? value._meta : undefined;
  const detail = meta && typeof meta === "object" ? meta[IMAGE_DETAIL_META_KEY] : undefined;
  return typeof detail === "string" && validImageDetails.has(detail) ? detail : undefined;
};

const imageWithDetail = (block, detail) => ({
  ...block,
  _meta: {
    ...(block._meta && typeof block._meta === "object" ? block._meta : {}),
    [IMAGE_DETAIL_META_KEY]: detail ?? DEFAULT_IMAGE_DETAIL,
  },
});

const normalizeImageBlock = (value, detailOverride) => {
  const override = normalizeImageDetail(detailOverride);
  if (typeof value === "string") {
    return imageWithDetail({ type: "image", ...parseDataImageUrl(value) }, override);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      "image expects a non-empty data URI, an object with image_url and optional detail, or a raw MCP image block",
    );
  }
  if (typeof value.image_url === "string") {
    return imageWithDetail(
      { type: "image", ...parseDataImageUrl(value.image_url) },
      override ?? normalizeImageDetail(value.detail),
    );
  }
  if (value.type === "image" && typeof value.data === "string") {
    const parsed = value.data.toLowerCase().startsWith("data:")
      ? parseDataImageUrl(value.data)
      : {
          data: value.data,
          mimeType:
            typeof value.mimeType === "string"
              ? value.mimeType
              : typeof value.mime_type === "string"
                ? value.mime_type
                : "application/octet-stream",
        };
    return imageWithDetail(
      { ...value, type: "image", data: parsed.data, mimeType: parsed.mimeType },
      override ?? imageDetailFromMeta(value),
    );
  }
  throw new TypeError(
    "image expects a non-empty data URI, an object with image_url and optional detail, or a raw MCP image block",
  );
};

const text = (value) => {
  recordOutput({ type: "content", content: { type: "text", text: formatOutputText(value) } });
};

const image = (value, detail) => {
  recordOutput({ type: "content", content: normalizeImageBlock(value, detail) });
};

const audio = (value) => {
  if (!isMcpAudioContentBlock(value)) {
    throw new TypeError("audio expects an MCP audio content block");
  }
  recordOutput({ type: "content", content: value });
};

const file = (value) => {
  if (!isToolFile(value)) {
    throw new TypeError("file expects a ToolFile value");
  }
  recordOutput({ type: "file", file: value });
};

const resource = (value) => {
  if (!isMcpResourceContentBlock(value) && !isMcpResourceLinkContentBlock(value)) {
    throw new TypeError("resource expects an MCP resource or resource_link content block");
  }
  recordOutput({ type: "content", content: value });
};

const notify = (value) => {
  const notification =
    value && typeof value === "object" && typeof value.message === "string"
      ? {
          message: value.message,
          ...(Object.prototype.hasOwnProperty.call(value, "data") ? { data: value.data } : {}),
        }
      : { message: formatOutputText(value) };
  recordOutput({ type: "notification", notification });
};

const yield_control = () =>
  new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pendingYieldCalls.set(requestId, { resolve, reject });
    writeIpcMessage({ type: "yield", nonce: ipcNonce, requestId });
  });

const yieldControl = yield_control;

const emit = (value) => {
  if (isToolFile(value)) {
    file(value);
    return;
  }
  if (isMcpContentBlock(value)) {
    recordOutput({ type: "content", content: value });
    return;
  }
  text(value);
};

const sandboxConsole = {
  log: (...args) => {
    logs.push(`[log] ${formatLogLine(args)}`);
  },
  warn: (...args) => {
    logs.push(`[warn] ${formatLogLine(args)}`);
  },
  error: (...args) => {
    logs.push(`[error] ${formatLogLine(args)}`);
  },
  info: (...args) => {
    logs.push(`[info] ${formatLogLine(args)}`);
  },
  debug: (...args) => {
    logs.push(`[debug] ${formatLogLine(args)}`);
  },
};

const runUserCode = async (code) => {
  outputs = [];
  const tools = createToolsProxy();

  const execute = new Function(
    "tools",
    "console",
    "emit",
    "text",
    "image",
    "audio",
    "file",
    "resource",
    "notify",
    "yield_control",
    "yieldControl",
    `"use strict"; return (async () => {\n${code}\n})();`,
  );

  const result = await execute(
    tools,
    sandboxConsole,
    emit,
    text,
    image,
    audio,
    file,
    resource,
    notify,
    yield_control,
    yieldControl,
  );
  return { result, output: outputs.length > 0 ? outputs : undefined };
};

const handleStart = (message) => {
  if (started) {
    writeIpcMessage({
      type: "failed",
      nonce: ipcNonce,
      error: "start message already received",
      logs,
    });
    return;
  }

  started = true;
  ipcNonce = typeof message.nonce === "string" ? message.nonce : "";

  runUserCode(message.code)
    .then(({ result, output }) => {
      writeIpcMessage({
        type: "completed",
        nonce: ipcNonce,
        result,
        output,
        logs,
      });
    })
    .catch((error) => {
      writeIpcMessage({
        type: "failed",
        nonce: ipcNonce,
        error: toErrorMessage(error),
        output: outputs.length > 0 ? outputs : undefined,
        logs,
      });
    });
};

const handleToolResult = (message) => {
  if (message.nonce !== ipcNonce) {
    return;
  }

  const pending = pendingToolCalls.get(message.requestId);
  if (!pending) {
    return;
  }

  pendingToolCalls.delete(message.requestId);

  if (message.ok) {
    pending.resolve(message.value);
    return;
  }

  pending.reject(new Error(message.error));
};

const handleYieldResult = (message) => {
  if (message.nonce !== ipcNonce) {
    return;
  }

  const pending = pendingYieldCalls.get(message.requestId);
  if (!pending) {
    return;
  }

  pendingYieldCalls.delete(message.requestId);

  if (message.ok) {
    pending.resolve();
    return;
  }

  pending.reject(new Error(message.error));
};

const handleHostMessage = (message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "start") {
    handleStart(message);
    return;
  }

  if (message.type === "tool_result") {
    handleToolResult(message);
    return;
  }

  if (message.type === "yield_result") {
    handleYieldResult(message);
  }
};

const decodeLines = async () => {
  const reader = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) {
        break;
      }

      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);

      if (line.length === 0) {
        continue;
      }

      try {
        const message = JSON.parse(line);
        handleHostMessage(message);
      } catch (error) {
        writeIpcMessage({
          type: "failed",
          nonce: ipcNonce,
          error: `invalid host message: ${toErrorMessage(error)}`,
          logs,
        });
      }
    }
  }
};

await decodeLines();
