#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export const validateReleaseVersion = (value: string): string => {
  if (!RELEASE_VERSION_PATTERN.test(value)) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return value;
};

export const validateReleaseTag = (value: string): string => {
  if (!value.startsWith("v")) {
    throw new Error(`Invalid release tag: ${value}`);
  }
  validateReleaseVersion(value.slice(1));
  return value;
};

const readEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
};

const appendGitHubFile = (path: string | undefined, line: string): void => {
  if (!path || !line) return;
  appendFileSync(path, `${line}\n`, "utf8");
};

const run = (): void => {
  const args = process.argv.slice(2);
  const tagEnv = readOption(args, "--tag-env");
  const versionEnv = readOption(args, "--version-env");
  const writeEnv = readOption(args, "--write-env");
  const outputName = readOption(args, "--output");

  if (tagEnv && versionEnv) {
    throw new Error("Use either --tag-env or --version-env, not both");
  }
  if (!tagEnv && !versionEnv) {
    throw new Error("Expected --tag-env or --version-env");
  }

  const tag = tagEnv
    ? validateReleaseTag(readEnv(tagEnv))
    : `v${validateReleaseVersion(readEnv(versionEnv!))}`;

  appendGitHubFile(process.env.GITHUB_ENV, writeEnv ? `${writeEnv}=${tag}` : "");
  appendGitHubFile(process.env.GITHUB_OUTPUT, outputName ? `${outputName}=${tag}` : "");
  console.log(`Validated release tag ${tag}`);
};

const readOption = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
};

if (import.meta.main) {
  run();
}
