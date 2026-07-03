import { describe, expect, test } from "bun:test";
import type { ExecResult, Sandbox } from "./interface";
import { installDatadogPupCli, readDatadogPupCliCredentials } from "./datadog-pup-cli";

function result(params: Partial<ExecResult> = {}): ExecResult {
  return {
    success: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    ...params,
  };
}

type RecordedSandbox = Sandbox & {
  readonly commands: string[];
  readonly directories: string[];
  readonly files: Map<string, string>;
};

function createSandbox(homeDirectory = "/home/vercel-sandbox"): RecordedSandbox {
  const commands: string[] = [];
  const directories: string[] = [];
  const files = new Map<string, string>();

  return {
    type: "cloud",
    workingDirectory: "/workspace",
    exec: async (command) => {
      commands.push(command);
      return command === 'printf %s "$HOME"' ? result({ stdout: homeDirectory }) : result();
    },
    readFile: async (path) => files.get(path) ?? "",
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    readFileBuffer: async () => Buffer.from(""),
    access: async () => {},
    stat: async () => ({
      isDirectory: () => false,
      isFile: () => true,
      size: 0,
      mtimeMs: 0,
    }),
    mkdir: async (path) => {
      directories.push(path);
    },
    readdir: async () => [],
    exists: async () => true,
    stop: async () => {},
    commands,
    directories,
    files,
  } as RecordedSandbox;
}

describe("readDatadogPupCliCredentials", () => {
  test("reads configured JSON credentials from the production secret", () => {
    const credentials = readDatadogPupCliCredentials({
      OPEN_AGENTS_DATADOG_PUP_CLI_SECRET: JSON.stringify({
        apiKey: "datadog-api-key",
        appKey: "datadog-app-key",
        site: "datadoghq.com",
      }),
    });

    expect(credentials).toEqual({
      apiKey: "datadog-api-key",
      appKey: "datadog-app-key",
      site: "datadoghq.com",
    });
  });
});

describe("installDatadogPupCli", () => {
  test("installs Datadog env, global wrapper, local wrapper, and permissions", async () => {
    const sandbox = createSandbox();

    await installDatadogPupCli(sandbox, {
      apiKey: "datadog-api-key",
      appKey: "datadog-app-key",
      site: "datadoghq.com",
    });

    expect(sandbox.directories).toEqual([
      "/home/vercel-sandbox/.open-agents",
      "/home/vercel-sandbox/.local/bin",
    ]);
    expect(sandbox.files.get("/home/vercel-sandbox/.open-agents/datadog.env")).toBe(
      [
        "DD_API_KEY='datadog-api-key'",
        "DD_APP_KEY='datadog-app-key'",
        "DD_SITE='datadoghq.com'",
        "FORCE_AGENT_MODE='1'",
        "",
      ].join("\n"),
    );

    const wrapper = sandbox.files.get("/usr/local/bin/pup");
    expect(wrapper).toContain("https://api.github.com/repos/DataDog/pup/releases/latest");
    expect(wrapper).toContain("https://github.com/DataDog/pup/releases/download/$tag");
    expect(wrapper).toContain('. "$ENV_FILE"');
    expect(sandbox.files.get("/home/vercel-sandbox/.local/bin/pup")).toBe(wrapper);
    expect(sandbox.commands).toEqual([
      'printf %s "$HOME"',
      "chmod 700 '/home/vercel-sandbox/.open-agents' && chmod 600 '/home/vercel-sandbox/.open-agents/datadog.env' && chmod 755 '/usr/local/bin/pup' '/home/vercel-sandbox/.local/bin/pup'",
    ]);
  });
});
