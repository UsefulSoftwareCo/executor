import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { parse } from "jsonc-parser";
import { MAX_DELEGATION_TTL_MS } from "@executor-js/sdk";

import { loadConfig } from "./config";

type ConfigEnv = Parameters<typeof loadConfig>[0];

const makeEnv = (overrides: Partial<ConfigEnv> = {}): ConfigEnv => ({
  EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
  VITE_PUBLIC_SITE_URL: "https://executor.example.com",
  ...overrides,
});

describe("loadConfig", () => {
  it("rejects missing Cloudflare Access configuration outside local development", () => {
    expect(() => loadConfig(makeEnv())).toThrowError(
      "Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD before serving requests.",
    );
  });

  it("rejects the repository's former team-domain placeholder", () => {
    expect(() =>
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "your-team.cloudflareaccess.com",
          ACCESS_AUD: "aud-tag",
        }),
      ),
    ).toThrowError(
      "Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN before serving requests.",
    );
  });

  it("allows local development to bypass Cloudflare Access", () => {
    expect(loadConfig(makeEnv({ ENABLE_DEV_AUTH: "true" }))).toMatchObject({
      accessTeamDomain: "",
      accessAud: "",
      enableDevAuth: true,
    });
  });

  it("normalises configured Access values without requiring an administrator", () => {
    expect(
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "https://Team.cloudflareaccess.com/",
          ACCESS_AUD: " aud-tag ",
        }),
      ),
    ).toMatchObject({
      accessTeamDomain: "Team.cloudflareaccess.com",
      accessAud: "aud-tag",
      adminEmails: [],
      enableDevAuth: false,
    });
  });

  it("honors a positive operator TTL cap within the SDK maximum", () => {
    expect(
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          ACCESS_AUD: "aud-tag",
          DELEGATED_MAX_TTL_MS: "604800000",
        }),
      ).delegatedMaxTtlMs,
    ).toBe(604800000);
    expect(() =>
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          ACCESS_AUD: "aud-tag",
          DELEGATED_MAX_TTL_MS: String(MAX_DELEGATION_TTL_MS + 1),
        }),
      ),
    ).toThrowError("DELEGATED_MAX_TTL_MS");
  });

  it("rejects token lifecycle claims as recent-auth evidence", () => {
    for (const claim of ["iat", "exp", "nbf", "sub"]) {
      expect(() =>
        loadConfig(
          makeEnv({
            ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
            ACCESS_AUD: "aud-tag",
            DELEGATED_RECENT_AUTH_CLAIM: claim,
          }),
        ),
      ).toThrowError("DELEGATED_RECENT_AUTH_CLAIM");
    }
  });
});

describe("Cloudflare deployment configuration", () => {
  it("preserves operator-managed Access variables across deploys", () => {
    const config = parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
      readonly keep_vars?: boolean;
      readonly vars?: Readonly<Record<string, unknown>>;
    };

    expect(config.keep_vars).toBe(true);
    expect(config.vars).not.toHaveProperty("ACCESS_TEAM_DOMAIN");
    expect(config.vars).not.toHaveProperty("ACCESS_AUD");
    expect(config.vars).not.toHaveProperty("ADMIN_EMAILS");
    expect(config.vars).toHaveProperty("ENABLE_DEV_AUTH", "false");
  });
});
