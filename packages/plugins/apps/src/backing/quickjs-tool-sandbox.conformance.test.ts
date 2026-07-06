import { toolSandboxConformance } from "../seams/tool-sandbox.conformance";
import { makeQuickjsToolSandbox } from "./quickjs-tool-sandbox";

// Short timeout so the "kills a runaway handler" case finishes quickly.
toolSandboxConformance("quickjs", () =>
  makeQuickjsToolSandbox({ collectTimeoutMs: 5_000, invokeTimeoutMs: 2_000 }),
);
