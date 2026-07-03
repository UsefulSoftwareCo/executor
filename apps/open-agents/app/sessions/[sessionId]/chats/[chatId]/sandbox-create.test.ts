import { afterEach, describe, expect, test } from "bun:test";
import { createSandbox, getSandboxCreateErrorDetails } from "./sandbox-create";

const originalFetch = globalThis.fetch;

type TestFetch = typeof fetch;

function setFetchResponse(response: Response): void {
  globalThis.fetch = Object.assign(async () => response, {
    preconnect: () => {},
  }) satisfies TestFetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createSandbox", () => {
  test("surfaces sandbox setup failure reasons to the user", async () => {
    setFetchResponse(
      new Response(
        JSON.stringify({
          error: "Failed to create sandbox",
          reason:
            "Failed to clone repository 'https://github.com/GoAugment/augment-services' (exit code 128): fatal: unable to access 'https://github.com/GoAugment/augment-services/': error adding trust anchors from file: /etc/ssl/certs/ca-certificates.crt while [sandbox-create] clone-source-start",
        }),
        { status: 500 },
      ),
    );

    let details: ReturnType<typeof getSandboxCreateErrorDetails> | null = null;
    try {
      await createSandbox(
        "https://github.com/GoAugment/augment-services",
        "main",
        false,
        "session-1",
        "vercel",
      );
    } catch (error) {
      details = getSandboxCreateErrorDetails(error);
    }

    expect(details).toEqual({
      message:
        "Failed to create sandbox: Failed to clone repository 'https://github.com/GoAugment/augment-services' (exit code 128): fatal: unable to access 'https://github.com/GoAugment/augment-services/': error adding trust anchors from file: /etc/ssl/certs/ca-certificates.crt while [sandbox-create] clone-source-start",
    });
  });

  test("does not duplicate a reason that already includes the display message", async () => {
    setFetchResponse(
      new Response(
        JSON.stringify({
          error: "GitHub App not installed for this organization",
          reason: "GitHub App not installed for this organization. Install it from Settings > Connections.",
        }),
        { status: 403 },
      ),
    );

    let details: ReturnType<typeof getSandboxCreateErrorDetails> | null = null;
    try {
      await createSandbox(
        "https://github.com/GoAugment/augment-services",
        "main",
        false,
        "session-1",
        "vercel",
      );
    } catch (error) {
      details = getSandboxCreateErrorDetails(error);
    }

    expect(details).toEqual({
      message: "GitHub App not installed for this organization. Install it from Settings > Connections.",
    });
  });
});
