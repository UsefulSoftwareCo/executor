import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@effect/vitest";

import { loadConfig } from "../config";

// Keep generated secret/key files out of the repo (loadConfig persists them).
process.env.EXECUTOR_DATA_DIR ??= mkdtempSync(join(tmpdir(), "origin-cfg-"));

// The "Invalid origin" sign-up failure on a PaaS came from webBaseUrl defaulting
// to localhost: Better Auth's trustedOrigins is [config.webBaseUrl], so the real
// public origin never matched. The fix resolves webBaseUrl from the platform's
// injected origin (Railway/Render/Fly/…) when EXECUTOR_WEB_BASE_URL is unset, so
// a PaaS deploy is zero-config. These pin that resolution; the origin check that
// consumes it is Better Auth's and unchanged.

// Clear every origin source so each test starts from a known state (no
// try/finally — these are the only env vars these cases read).
const PLATFORM_VARS = [
  "EXECUTOR_WEB_BASE_URL",
  "EXECUTOR_TRUSTED_ORIGINS",
  "RAILWAY_PUBLIC_DOMAIN",
  "RENDER_EXTERNAL_URL",
  "RENDER_EXTERNAL_HOSTNAME",
  "FLY_APP_NAME",
  "VERCEL_URL",
];
const resetOriginEnv = (): void => {
  for (const key of PLATFORM_VARS) delete process.env[key];
  process.env.PORT = "4788";
};

test("webBaseUrl falls back to localhost with no public origin", () => {
  resetOriginEnv();
  const config = loadConfig();
  expect(config.webBaseUrl).toBe("http://localhost:4788");
  expect(config.trustedOrigins).toEqual(["http://localhost:4788"]);
});

test("webBaseUrl auto-resolves from a platform host var (Railway, host only → https)", () => {
  resetOriginEnv();
  process.env.RAILWAY_PUBLIC_DOMAIN = "demo-production.up.railway.app";
  expect(loadConfig().webBaseUrl).toBe("https://demo-production.up.railway.app");
});

test("webBaseUrl auto-resolves from a platform URL var (Render, full URL, trailing slash trimmed)", () => {
  resetOriginEnv();
  process.env.RENDER_EXTERNAL_URL = "https://demo.onrender.com/";
  expect(loadConfig().webBaseUrl).toBe("https://demo.onrender.com");
});

test("Fly's app name becomes the .fly.dev origin", () => {
  resetOriginEnv();
  process.env.FLY_APP_NAME = "demo-app";
  expect(loadConfig().webBaseUrl).toBe("https://demo-app.fly.dev");
});

test("an explicit EXECUTOR_WEB_BASE_URL always wins over a platform var", () => {
  resetOriginEnv();
  process.env.RAILWAY_PUBLIC_DOMAIN = "ignored.up.railway.app";
  process.env.EXECUTOR_WEB_BASE_URL = "https://pinned.example.com";
  expect(loadConfig().webBaseUrl).toBe("https://pinned.example.com");
});

test("additional trusted origins are trimmed, normalized, and deduplicated", () => {
  resetOriginEnv();
  process.env.EXECUTOR_WEB_BASE_URL = "https://executor.example.com";
  process.env.EXECUTOR_TRUSTED_ORIGINS =
    " http://executor.home.arpa:4788/, https://executor.example.com, http://192.0.2.10:4788 ";
  expect(loadConfig().trustedOrigins).toEqual([
    "https://executor.example.com",
    "http://executor.home.arpa:4788",
    "http://192.0.2.10:4788",
  ]);
});

test("an empty or blank trusted-origins list leaves the canonical origin alone", () => {
  resetOriginEnv();
  process.env.EXECUTOR_WEB_BASE_URL = "https://executor.example.com";
  process.env.EXECUTOR_TRUSTED_ORIGINS = "  , ,  ";
  expect(loadConfig().trustedOrigins).toEqual(["https://executor.example.com"]);
});

// Every rejected shape is one an operator could plausibly type and then believe
// was in force. A wildcard host is the dangerous one: accepting it as a literal
// hostname would silently allow nothing while reading like it allows a whole
// domain. A path/query/fragment reads like a scoped grant that origins cannot
// express, and credentials in the URL are almost always a copy-paste mistake.
test.each([
  "https://executor.example.com/login",
  "https://executor.example.com/?next=/",
  "https://executor.example.com/#top",
  "https://user:pass@executor.example.com",
  "https://*.example.com",
  "file:///tmp/executor",
  "ftp://executor.example.com",
])("a trusted origin that is not an exact http(s) origin (%s) refuses to boot", (raw) => {
  resetOriginEnv();
  process.env.EXECUTOR_TRUSTED_ORIGINS = raw;
  expect(() => loadConfig()).toThrow(/exact http\(s\) origin/);
});

// A bare hostname is the most common typo, and it never parses as a URL at all,
// so it gets the other message. Both name the variable.
test.each(["executor.example.com", "//executor.example.com", "not a url"])(
  "a trusted origin that is not a URL (%s) refuses to boot",
  (raw) => {
    resetOriginEnv();
    process.env.EXECUTOR_TRUSTED_ORIGINS = raw;
    expect(() => loadConfig()).toThrow(/EXECUTOR_TRUSTED_ORIGINS/);
  },
);
