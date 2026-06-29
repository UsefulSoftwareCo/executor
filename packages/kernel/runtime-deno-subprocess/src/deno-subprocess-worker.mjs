// This script runs inside the Deno subprocess.
// It communicates with the host process via line-delimited JSON over stdin/stdout.
// All IPC messages are prefixed with @@executor-ipc@@ to distinguish from user output.

const encoder = new TextEncoder();
const IPC_PREFIX = "@@executor-ipc@@";

const pendingToolCalls = new Map();
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

const createToolsProxy = (path = []) => {
  const callable = () => undefined;

  return new Proxy(callable, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (typeof prop !== "string") return undefined;
      return createToolsProxy([...path, prop]);
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
  typeof value.mimeType === "string";

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

const emit = (value) => {
  if (isToolFile(value)) {
    outputs.push({ type: "file", file: value });
    return;
  }
  if (isMcpContentBlock(value)) {
    outputs.push({ type: "content", content: value });
    return;
  }
  outputs.push({ type: "content", content: { type: "text", text: formatOutputText(value) } });
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
    `"use strict"; return (async () => {\n${code}\n})();`,
  );

  const result = await execute(tools, sandboxConsole, emit);
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
