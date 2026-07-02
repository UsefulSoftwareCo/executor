import { describe, expect, it } from "@effect/vitest";

import { browserOpenCommand } from "./device-login";

describe("browserOpenCommand", () => {
  it("opens Windows browser URLs without cmd.exe", () => {
    const command = browserOpenCommand(
      "https://executor.example/login?next=a%20b&token=abc123",
      "win32",
    );

    expect(command).toEqual([
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", "https://executor.example/login?next=a%20b&token=abc123"],
    ]);
  });

  it("passes the browser URL as one argument on every platform", () => {
    expect(browserOpenCommand("https://executor.example/login?x=1&y=2", "darwin")).toEqual([
      "open",
      ["https://executor.example/login?x=1&y=2"],
    ]);
    expect(browserOpenCommand("https://executor.example/login?x=1&y=2", "linux")).toEqual([
      "xdg-open",
      ["https://executor.example/login?x=1&y=2"],
    ]);
  });

  it("refuses non-browser URL schemes", () => {
    expect(browserOpenCommand("javascript:alert(1)", "win32")).toBeUndefined();
    expect(browserOpenCommand("file:///C:/Windows/System32/calc.exe", "win32")).toBeUndefined();
    expect(browserOpenCommand("not a url", "win32")).toBeUndefined();
  });
});
