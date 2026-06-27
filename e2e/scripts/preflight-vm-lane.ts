import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { projectDefinition, type E2eCapability } from "../src/project-matrix";
import { preflightLinuxKvm } from "../src/vm/linux-kvm";

const execFileP = promisify(execFile);

const requireEnvironment = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for this requested VM lane`);
  return value;
};

const executablePath = async (command: string) => {
  const candidates = command.includes("/")
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`required executable is unavailable: ${command}`);
};

const execute = async (command: string, args: ReadonlyArray<string>) => {
  const executable = await executablePath(command);
  try {
    const result = await execFileP(executable, [...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return `${result.stdout}\n${result.stderr}`.trim();
  } catch (error) {
    throw new Error(`required capability probe failed: ${command} ${args.join(" ")}`, {
      cause: error,
    });
  }
};

const assertProjectContract = (
  projectName: string,
  expectedCapabilities: ReadonlyArray<E2eCapability>,
) => {
  const project = projectDefinition(projectName);
  if (!project) throw new Error(`unknown VM project: ${projectName}`);
  if (project.tier !== "heavy-vm" || !project.hermetic) {
    throw new Error(`${projectName} must remain a hermetic heavy-vm project`);
  }
  const missing = expectedCapabilities.filter(
    (capability) => !project.requiredCapabilities.some((required) => required === capability),
  );
  if (missing.length > 0) {
    throw new Error(`${projectName} does not require expected capabilities: ${missing.join(", ")}`);
  }
};

const preflightTart = async (os: "macos" | "linux") => {
  assertProjectContract(`cli-${os}`, ["api", "restart"]);
  requireEnvironment("E2E_VM_RUN_SCOPE");
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`tart ${os} requires a darwin arm64 runner`);
  }

  const tart = process.env.E2E_TART_BIN ?? "/opt/homebrew/bin/tart";
  const sshpass = process.env.E2E_SSHPASS_BIN ?? "/opt/homebrew/bin/sshpass";
  const baseImage =
    os === "macos"
      ? (process.env.E2E_TART_MACOS_BASE ?? "executor-macos-base")
      : (process.env.E2E_TART_LINUX_BASE ?? "executor-linux-base");
  await Promise.all([
    execute(tart, ["--version"]),
    execute(sshpass, ["-V"]),
    executablePath("ssh"),
    executablePath("scp"),
  ]);
  const images = await execute(tart, ["list"]);
  if (!images.split(/\s+/).includes(baseImage)) {
    throw new Error(`required tart base image is unavailable: ${baseImage}`);
  }
};

const preflightEc2 = async () => {
  assertProjectContract("cli-windows", ["api", "restart"]);
  requireEnvironment("E2E_VM_RUN_SCOPE");
  requireEnvironment("AWS_ACCESS_KEY_ID");
  requireEnvironment("AWS_SECRET_ACCESS_KEY");
  const aws = process.env.E2E_AWS_BIN ?? "aws";
  const region = process.env.E2E_EC2_REGION ?? "us-west-2";
  await Promise.all([
    executablePath("curl"),
    executablePath("scp"),
    executablePath("ssh"),
    executablePath("ssh-keygen"),
  ]);
  await execute(aws, ["--region", region, "sts", "get-caller-identity", "--output", "json"]);
  const defaultVpc = await execute(aws, [
    "--region",
    region,
    "ec2",
    "describe-vpcs",
    "--filters",
    "Name=isDefault,Values=true",
    "--query",
    "Vpcs[0].VpcId",
    "--output",
    "text",
  ]);
  if (!defaultVpc || defaultVpc === "None") {
    throw new Error(`EC2 ${region} has no default VPC for the Windows VM lane`);
  }
};

const main = async () => {
  const [lane, guest] = process.argv.slice(2);
  if (process.env.E2E_REQUIRED_CAPABILITY_MODE !== "required") {
    throw new Error("requested VM lanes must set E2E_REQUIRED_CAPABILITY_MODE=required");
  }
  if (lane === "linux-kvm") {
    assertProjectContract("desktop-kvm", ["desktop-gui"]);
    requireEnvironment("E2E_KVM_CLEANUP_LEDGER");
    requireEnvironment("E2E_KVM_RUN_SCOPE");
    await preflightLinuxKvm({ requirement: "required" });
  } else if (lane === "tart" && (guest === "macos" || guest === "linux")) {
    await preflightTart(guest);
  } else if (lane === "ec2" && guest === "windows") {
    await preflightEc2();
  } else {
    throw new Error(
      "usage: bun e2e/scripts/preflight-vm-lane.ts linux-kvm | tart <macos|linux> | ec2 windows",
    );
  }
  console.log(`VM capability preflight passed: ${lane}${guest ? ` ${guest}` : ""}`);
};

main().catch((error: unknown) => {
  console.error(`VM capability preflight failed: ${String(error)}`);
  process.exitCode = 1;
});
