/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: URL parsing helpers throw into Effect and Promise adapters */
export interface GitUrlPolicy {
  readonly allowPrivateHosts?: boolean;
}

const TOKEN_QUERY_KEYS =
  /(?:token|access[_-]?token|auth|authorization|key|secret|password|credential)/i;

export const redactUrl = (input: string): string => {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return input.replace(/\/\/[^/@\s]+@/g, "//").replace(/[?#].*$/g, "");
  }
};

export const hasTokenLikeQuery = (url: URL): boolean => {
  for (const key of url.searchParams.keys()) {
    if (TOKEN_QUERY_KEYS.test(key)) return true;
  }
  return false;
};

const normalizeHost = (host: string): string => host.replace(/^\[|\]$/g, "").toLowerCase();

const parseDecimalIpv4 = (host: string): string | null => {
  if (!/^[0-9]+$/.test(host)) return null;
  const value = Number(host);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
  return [
    Math.floor(value / 16777216) & 255,
    Math.floor(value / 65536) & 255,
    Math.floor(value / 256) & 255,
    value & 255,
  ].join(".");
};

const parseSegmentedIpv4 = (host: string): string | null => {
  const parts = host.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  const nums = parts.map((part) => {
    if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part.slice(2), 16);
    if (/^0[0-7]+$/.test(part)) return Number.parseInt(part.slice(1), 8);
    if (/^[0-9]+$/.test(part)) return Number.parseInt(part, 10);
    return Number.NaN;
  });
  if (nums.some((part) => !Number.isInteger(part) || part < 0)) return null;
  const maxTail = [0, 0xffffff, 0xffff, 0xff][parts.length - 1] ?? 0xff;
  if (nums.slice(0, -1).some((part) => part > 255) || nums[nums.length - 1]! > maxTail) {
    return null;
  }
  let value = 0;
  for (let index = 0; index < nums.length - 1; index += 1) {
    value = value * 256 + nums[index]!;
  }
  const tailBytes = 5 - nums.length;
  value = value * 256 ** tailBytes + nums[nums.length - 1]!;
  return [
    Math.floor(value / 16777216) & 255,
    Math.floor(value / 65536) & 255,
    Math.floor(value / 256) & 255,
    value & 255,
  ].join(".");
};

const canonicalIpv4 = (host: string): string | null => {
  const lower = host.toLowerCase();
  if (/^[0-9]+$/.test(lower)) return parseDecimalIpv4(lower);
  if (/^(?:0x[0-9a-f]+|0[0-7]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|0[0-7]+|[0-9]+)){1,3}$/i.test(lower)) {
    return parseSegmentedIpv4(lower);
  }
  if (/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(lower)) return lower;
  return null;
};

const ipv4FromMappedIpv6 = (host: string): string | null => {
  const normalized = normalizeHost(host);
  if (!normalized.startsWith("::ffff:")) return null;
  const tail = normalized.slice("::ffff:".length);
  if (tail.includes(".")) return canonicalIpv4(tail);
  if (tail.includes(":")) {
    const parts = tail.split(":");
    if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
    const value = Number.parseInt(parts[0]!, 16) * 65536 + Number.parseInt(parts[1]!, 16);
    return [
      Math.floor(value / 16777216) & 255,
      Math.floor(value / 65536) & 255,
      Math.floor(value / 256) & 255,
      value & 255,
    ].join(".");
  }
  const compact = tail.replace(/:/g, "");
  if (!/^[0-9a-f]{8}$/i.test(compact)) return null;
  const value = Number.parseInt(compact, 16);
  return [
    Math.floor(value / 16777216) & 255,
    Math.floor(value / 65536) & 255,
    Math.floor(value / 256) & 255,
    value & 255,
  ].join(".");
};

const isPrivateIpv4 = (host: string): boolean => {
  const canonical = canonicalIpv4(host);
  if (!canonical) return false;
  const nums = canonical.split(".").map((part) => Number(part));
  const [a, b] = nums;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
};

export const isPrivateGitHost = (host: string): boolean => {
  const normalized = normalizeHost(host);
  const mapped = ipv4FromMappedIpv6(normalized);
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    isPrivateIpv4(mapped ?? normalized)
  );
};

export const validateGitFetchUrl = (input: string, policy: GitUrlPolicy = {}): URL => {
  const url = new URL(input);
  if (url.protocol !== "https:") throw new Error("git source URL must use https");
  if (url.username || url.password)
    throw new Error("git source URL must not include embedded credentials");
  if (hasTokenLikeQuery(url))
    throw new Error("git source URL must not include token query parameters");
  if (policy.allowPrivateHosts !== true && isPrivateGitHost(url.hostname)) {
    throw new Error("git source URL host is not allowed");
  }
  return url;
};
