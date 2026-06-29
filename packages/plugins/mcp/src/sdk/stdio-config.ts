import type { McpStdioIntegrationConfig } from "./types";

export type StdioEnvParseError =
  | { readonly kind: "missing_equals"; readonly line: number }
  | { readonly kind: "empty_key"; readonly line: number }
  | { readonly kind: "invalid_key"; readonly line: number; readonly key: string }
  | { readonly kind: "duplicate_key"; readonly line: number; readonly key: string };

export type StdioEnvParseResult =
  | { readonly ok: true; readonly env: Record<string, string> | undefined }
  | { readonly ok: false; readonly error: StdioEnvParseError };

export type CanonicalStdioConfig = {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
};

const STDIO_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const parseStdioArgs = (raw: string): string[] => {
  if (!raw.trim()) return [];
  const args: string[] = [];
  const regex = /[^\s"]+|"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    args.push(match[1] ?? match[0]);
  }
  return args;
};

const parseStdioEnvValue = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\([\\nrt"])/g, (_match: string, escaped: string): string => {
        if (escaped === "n") return "\n";
        if (escaped === "r") return "\r";
        if (escaped === "t") return "\t";
        return escaped;
      });
  }
  return trimmed;
};

export const parseStdioEnv = (raw: string): StdioEnvParseResult => {
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  const lines = raw.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.trim().length === 0) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      return { ok: false, error: { kind: "missing_equals", line: lineNumber } };
    }

    const key = line.slice(0, equalsIndex).trim();
    if (key.length === 0) {
      return { ok: false, error: { kind: "empty_key", line: lineNumber } };
    }
    if (!STDIO_ENV_KEY_PATTERN.test(key)) {
      return { ok: false, error: { kind: "invalid_key", line: lineNumber, key } };
    }
    if (seen.has(key)) {
      return { ok: false, error: { kind: "duplicate_key", line: lineNumber, key } };
    }

    seen.add(key);
    env[key] = parseStdioEnvValue(line.slice(equalsIndex + 1));
  }

  return { ok: true, env: Object.keys(env).length > 0 ? env : undefined };
};

const formatDoubleQuotedStdioEnvValue = (value: string): string =>
  `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;

const canFormatStdioEnvValueBare = (value: string): boolean => {
  if (/[\n\r\t"\\]/.test(value)) return false;
  const parsed = parseStdioEnv(`A=${value}`);
  return parsed.ok && parsed.env?.A === value;
};

const formatStdioEnvValue = (value: string): string => {
  if (value.length === 0) return "";
  if (canFormatStdioEnvValueBare(value)) return value;
  return formatDoubleQuotedStdioEnvValue(value);
};

export const stdioEnvToText = (env: Record<string, string> | undefined): string => {
  if (env === undefined || Object.keys(env).length === 0) return "";
  return Object.entries(env)
    .map(([key, value]) => `${key}=${formatStdioEnvValue(value)}`)
    .join("\n");
};

const normalizeEnv = (
  env: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (env === undefined) return undefined;
  const keys = Object.keys(env).sort();
  if (keys.length === 0) return undefined;
  const normalized: Record<string, string> = {};
  for (const key of keys) normalized[key] = env[key] ?? "";
  return normalized;
};

export const canonicalizeStdioConfig = (
  config: Pick<McpStdioIntegrationConfig, "command" | "args" | "env" | "cwd">,
): CanonicalStdioConfig => {
  const env = normalizeEnv(config.env);
  const cwd = config.cwd?.trim();
  return {
    transport: "stdio",
    command: config.command.trim(),
    ...(config.args !== undefined && config.args.length > 0 ? { args: [...config.args] } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
  };
};

export const canonicalizeStdioDraft = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string> | undefined;
  readonly cwd: string;
}): CanonicalStdioConfig =>
  canonicalizeStdioConfig({
    command: input.command,
    args: input.args.length > 0 ? [...input.args] : undefined,
    env: input.env,
    cwd: input.cwd,
  });

export const sameCanonicalStdioConfig = (
  left: CanonicalStdioConfig,
  right: CanonicalStdioConfig,
): boolean => {
  if (left.command !== right.command) return false;
  if ((left.cwd ?? undefined) !== (right.cwd ?? undefined)) return false;

  const leftArgs = left.args ?? [];
  const rightArgs = right.args ?? [];
  if (leftArgs.length !== rightArgs.length) return false;
  if (leftArgs.some((value, index) => value !== rightArgs[index])) return false;

  const leftEnv = left.env ?? {};
  const rightEnv = right.env ?? {};
  const leftKeys = Object.keys(leftEnv).sort();
  const rightKeys = Object.keys(rightEnv).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && leftEnv[key] === rightEnv[key]);
};

export const stdioEnvParseErrorMessage = (error: StdioEnvParseError): string => {
  if (error.kind === "missing_equals") {
    return `Environment line ${error.line} must use KEY=value.`;
  }
  if (error.kind === "empty_key") {
    return `Environment line ${error.line} is missing a variable name.`;
  }
  if (error.kind === "invalid_key") {
    return `Environment line ${error.line} has invalid variable name ${error.key}.`;
  }
  return `Environment line ${error.line} repeats variable ${error.key}.`;
};
