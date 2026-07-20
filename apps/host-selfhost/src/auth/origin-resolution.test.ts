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

test("additional trusted origins must be exact http(s) origins", () => {
  resetOriginEnv();
  process.env.EXECUTOR_TRUSTED_ORIGINS = "https://executor.example.com/login";
  expect(() => loadConfig()).toThrow(/exact http\(s\) origin/);

  process.env.EXECUTOR_TRUSTED_ORIGINS = "file:///tmp/executor";
  expect(() => loadConfig()).toThrow(/exact http\(s\) origin/);

  process.env.EXECUTOR_TRUSTED_ORIGINS = "https://*.example.com";
  expect(() => loadConfig()).toThrow(/exact http\(s\) origin/);
});
