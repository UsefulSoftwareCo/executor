import { describe, it, expect } from "@effect/vitest";
import { buildExecutorModule } from "./module-template";

describe("buildExecutorModule", () => {
  it("produces a valid ES module with WorkerEntrypoint import", () => {
    const module = buildExecutorModule("return 42;", 5000);
    expect(module).toContain('import { WorkerEntrypoint } from "cloudflare:workers"');
    expect(module).toContain("class CodeExecutor extends WorkerEntrypoint");
  });

  it("embeds the recovered body in an async wrapper inside Promise.race", () => {
    const module = buildExecutorModule("return 42;", 5000);
    expect(module).toContain("(async () => {");
    expect(module).toContain("return 42;");
    expect(module).toContain("})(),");
    expect(module).toContain("Promise.race");
  });

  it("includes the timeout value", () => {
    const module = buildExecutorModule("return 42;", 3000);
    expect(module).toContain("3000");
    expect(module).toContain("Execution timed out after 3000ms");
  });

  it("includes the tools proxy setup", () => {
    const module = buildExecutorModule("return 42;", 5000);
    expect(module).toContain("__makeToolsProxy");
    expect(module).toContain("__dispatcher.call");
    expect(module).toContain("const tools = __makeToolsProxy()");
  });

  it("captures console output", () => {
    const module = buildExecutorModule("return 42;", 5000);
    expect(module).toContain("const __logs = []");
    expect(module).toContain("console.log =");
    expect(module).toContain("console.warn =");
    expect(module).toContain("console.error =");
  });

  it("returns result, output, and logs on success", () => {
    const module = buildExecutorModule("return 42;", 5000);
    expect(module).toContain("return { result, output:");
    expect(module).toContain("logs: __logs }");
  });

  it("catches errors and returns them", () => {
    const module = buildExecutorModule("return 42;", 5000);
    expect(module).toContain("catch (err)");
    expect(module).toContain("const __serializeThrownError = (err) =>");
    expect(module).toContain("if (!data.ok)");
    expect(module).toContain("error: __serializeThrownError(err)");
  });
});
