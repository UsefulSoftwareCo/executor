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
  const tools = createToolsProxy();

  const execute = new Function(
    "tools",
    "console",
    `"use strict"; return (async () => {\n${code}\n})();`,
  );

  return await execute(tools, sandboxConsole);
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
    .then((result) => {
      writeIpcMessage({
        type: "completed",
        nonce: ipcNonce,
        result,
        logs,
      });
    })
    .catch((error) => {
      writeIpcMessage({
        type: "failed",
        nonce: ipcNonce,
        error: toErrorMessage(error),
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
