import { expect, test } from "@effect/vitest";

import {
  getPlatformOrigin,
  missingPublicOriginWarning,
  resolvePublicOrigin,
  shouldWarnMissingPublicOrigin,
} from "./public-origin";

test("getPlatformOrigin reads host-only vars as https, trims trailing slash on URL vars", () => {
  expect(getPlatformOrigin({ RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app" })).toBe(
    "https://demo.up.railway.app",
  );
  expect(getPlatformOrigin({ RENDER_EXTERNAL_URL: "https://demo.onrender.com/" })).toBe(
    "https://demo.onrender.com",
  );
  expect(getPlatformOrigin({ FLY_APP_NAME: "demo" })).toBe("https://demo.fly.dev");
  expect(getPlatformOrigin({ SITE_NAME: "demo" })).toBe("https://demo.netlify.app");
  expect(getPlatformOrigin({})).toBeUndefined();
  // A Worker env (no platform vars) yields nothing — the caller falls back.
  expect(getPlatformOrigin({ SOME_OTHER: "x" })).toBeUndefined();
});

test("resolvePublicOrigin: explicit wins over platform, else platform, else undefined", () => {
  expect(
    resolvePublicOrigin({
      explicit: "https://pinned.example.com",
      env: { RAILWAY_PUBLIC_DOMAIN: "x" },
    }),
  ).toBe("https://pinned.example.com");
  expect(
    resolvePublicOrigin({ explicit: "  ", env: { RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app" } }),
  ).toBe("https://demo.up.railway.app");
  expect(resolvePublicOrigin({ explicit: undefined, env: {} })).toBeUndefined();
});

test("shouldWarnMissingPublicOrigin warns unless dev/test", () => {
  expect(shouldWarnMissingPublicOrigin("production")).toBe(true);
  expect(shouldWarnMissingPublicOrigin("staging")).toBe(true);
  expect(shouldWarnMissingPublicOrigin(undefined)).toBe(true);
  expect(shouldWarnMissingPublicOrigin("development")).toBe(false);
  expect(shouldWarnMissingPublicOrigin("test")).toBe(false);
});

test("missingPublicOriginWarning names the var and the fallback", () => {
  const msg = missingPublicOriginWarning({
    varName: "EXECUTOR_WEB_BASE_URL",
    fallback: "http://localhost:4788",
  });
  expect(msg).toContain("EXECUTOR_WEB_BASE_URL");
  expect(msg).toContain("http://localhost:4788");
});
