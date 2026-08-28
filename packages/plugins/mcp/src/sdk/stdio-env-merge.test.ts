// How the inherited allowlist and the declared env combine, per platform.
//
// The sibling `stdio-env-isolation` suite spawns a real child and asks what it
// received. That answers the security question, but it can only ever measure
// the platform it runs on, and the defect here is Windows-only: a case-variant
// key collision. So this suite exercises the merge directly and passes the
// platform in, which lets the Windows behaviour be asserted from any host.

import { describe, expect, it } from "@effect/vitest";

import { mergeStdioEnv } from "./stdio-connector";

/** The keys the SDK's own safe-list places underneath our result on Windows. */
const windowsSdkKeys = ["APPDATA", "PATH", "SYSTEMROOT", "TEMP", "USERPROFILE"];

describe("mergeStdioEnv on a case-sensitive platform", () => {
  it("keeps both spellings, because they are two real variables", () => {
    // On Unix `HTTP_PROXY` and `http_proxy` are unrelated variables that
    // different tooling reads, and the allowlist inherits both on purpose.
    // Collapsing them here would drop configuration the host meant to pass.
    const merged = mergeStdioEnv({
      platform: "linux",
      inherited: { HTTP_PROXY: "http://host.invalid:3128" },
      declared: { http_proxy: "http://declared.invalid:8080" },
    });

    expect(merged).toStrictEqual({
      HTTP_PROXY: "http://host.invalid:3128",
      http_proxy: "http://declared.invalid:8080",
    });
  });

  it("lets the declared env win an exact key collision", () => {
    const merged = mergeStdioEnv({
      platform: "darwin",
      inherited: { HTTPS_PROXY: "http://host.invalid:3128" },
      declared: { HTTPS_PROXY: "http://declared.invalid:8080" },
    });

    expect(merged).toStrictEqual({ HTTPS_PROXY: "http://declared.invalid:8080" });
  });
});

describe("mergeStdioEnv on win32", () => {
  it("drops the inherited alias so the declared value is the only one", () => {
    // The defect: a case-sensitive spread emits `HTTP_PROXY` beside
    // `http_proxy`, both reach the child's environment block, and Windows
    // resolves the case-insensitive name to whichever comes first — not
    // necessarily the declared one. One entry can only resolve one way.
    const merged = mergeStdioEnv({
      platform: "win32",
      inherited: { HTTP_PROXY: "http://host.invalid:3128" },
      declared: { http_proxy: "http://declared.invalid:8080" },
    });

    expect(Object.keys(merged)).toStrictEqual(["http_proxy"]);
    expect(merged.http_proxy).toBe("http://declared.invalid:8080");
    expect(merged.HTTP_PROXY).toBeUndefined();
  });

  it("collapses aliases the allowlist itself produces", () => {
    // `process.env` is case-insensitive on Windows, so reading the allowlist's
    // uppercase and lowercase proxy spellings returns the same variable twice.
    // The child should be handed it once.
    const merged = mergeStdioEnv({
      platform: "win32",
      inherited: {
        HTTPS_PROXY: "http://host.invalid:3128",
        https_proxy: "http://host.invalid:3128",
      },
    });

    expect(Object.keys(merged)).toStrictEqual(["https_proxy"]);
    expect(merged.https_proxy).toBe("http://host.invalid:3128");
  });

  it("emits a declared key with the SDK's spelling when the SDK also sets it", () => {
    // The SDK spreads `getDefaultEnvironment()` underneath this result with a
    // case-sensitive spread, and its Windows list spells the variable `PATH`.
    // Returning `Path` would leave `PATH` standing beside it; returning `PATH`
    // replaces it, which is what a source that overrides its interpreter
    // lookup is asking for.
    const merged = mergeStdioEnv({
      platform: "win32",
      inherited: {},
      declared: { Path: "C:\\server\\bin" },
      sdkKeys: windowsSdkKeys,
    });

    expect(Object.keys(merged)).toStrictEqual(["PATH"]);
    expect(merged.PATH).toBe("C:\\server\\bin");
  });

  it("leaves a key the SDK does not set under its declared spelling", () => {
    const merged = mergeStdioEnv({
      platform: "win32",
      inherited: {},
      declared: { My_Api_Token: "declared-value" },
      sdkKeys: windowsSdkKeys,
    });

    expect(merged).toStrictEqual({ My_Api_Token: "declared-value" });
  });

  it("still passes an inherited variable the source does not declare", () => {
    // Deduplication must not turn into dropping: the proxy and CA settings are
    // the reason the allowlist exists.
    const merged = mergeStdioEnv({
      platform: "win32",
      inherited: { NODE_EXTRA_CA_CERTS: "C:\\certs\\corporate.pem" },
      declared: { DECLARED_TOKEN: "declared-value" },
      sdkKeys: windowsSdkKeys,
    });

    expect(merged).toStrictEqual({
      NODE_EXTRA_CA_CERTS: "C:\\certs\\corporate.pem",
      DECLARED_TOKEN: "declared-value",
    });
  });

  it("does not invent an entry for an SDK key nobody declared", () => {
    // The SDK supplies its own safe-list; this merge only decides spelling for
    // keys that are actually being passed.
    const merged = mergeStdioEnv({
      platform: "win32",
      inherited: {},
      declared: {},
      sdkKeys: windowsSdkKeys,
    });

    expect(merged).toStrictEqual({});
  });
});
