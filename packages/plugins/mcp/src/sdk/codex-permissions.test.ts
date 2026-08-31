import { describe, expect, it } from "@effect/vitest";

import {
  CODEX_PERMISSIONS,
  permissionFailure,
  permissionFailureMessage,
} from "./codex-permissions";

// ---------------------------------------------------------------------------
// The string below is verbatim what a Codex plugin returns when macOS has
// refused the grant — the numeric code is the ONLY signal, since the plugin's
// own wording is "Unknown error".
// ---------------------------------------------------------------------------

const DENIED = "Computer Use server error -1743: Unknown error";

describe("permissionFailure", () => {
  it("recognises a denial behind the plugin's own 'Unknown error'", () => {
    const permission = permissionFailure(DENIED, "codex-messages");

    expect(permission?.id).toBe("automation");
    // Automation is granted per HOST, so the entry names executor, not
    // anything Codex ships.
    expect(permission?.entry).toBe("Executor → Messages");
  });

  it("recognises the other codes the same denial presents as", () => {
    for (const code of [-609, -600]) {
      expect(permissionFailure(`server error ${code}: Unknown error`, "codex-messages")).not.toBe(
        null,
      );
    }
  });

  it("leaves ordinary tool failures alone", () => {
    expect(permissionFailure("No chat matched that name", "codex-messages")).toBe(null);
    // A number that merely contains a code must not trip it.
    expect(permissionFailure("read 21743 rows", "codex-messages")).toBe(null);
    expect(permissionFailure("error -17430: other", "codex-messages")).toBe(null);
  });

  it("returns nothing to say for an unknown plugin", () => {
    expect(permissionFailure(DENIED, undefined)).toBe(null);
    expect(permissionFailure(DENIED, "codex-openai-docs")).toBe(null);
  });
});

describe("permissionFailureMessage", () => {
  it("says what was blocked, which switch to flip, and that macOS will not ask again", () => {
    const permission = permissionFailure(DENIED, "codex-messages")!;
    const message = permissionFailureMessage(permission);

    expect(message).toContain("macOS blocked this");
    expect(message).toContain("Privacy & Security → Automation");
    expect(message).toContain('"Executor → Messages"');
    expect(message).toContain("only asks once");
  });
});

describe("CODEX_PERMISSIONS", () => {
  it("points every entry at a real settings pane", () => {
    for (const [preset, permissions] of Object.entries(CODEX_PERMISSIONS)) {
      expect(permissions.length, preset).toBeGreaterThan(0);
      for (const permission of permissions) {
        expect(permission.settingsUrl, `${preset}/${permission.id}`).toMatch(
          /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_/,
        );
        expect(permission.why.length, `${preset}/${permission.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("attributes the Codex-owned grants to Codex, not to the host", () => {
    // Screen Recording and Accessibility are held by the Computer Use app, so
    // granting them once in Codex covers every host — the entry must say so.
    const computerUse = CODEX_PERMISSIONS["codex-computer-use"]!;
    expect(computerUse.map((p) => p.entry)).toEqual(["Codex Computer Use", "Codex Computer Use"]);
  });
});
