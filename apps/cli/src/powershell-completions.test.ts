import { describe, expect, it } from "@effect/vitest";

import { generatePowerShellCompletions } from "./powershell-completions";

describe("generatePowerShellCompletions", () => {
  it("registers a native completer that discovers contextual help", () => {
    const script = generatePowerShellCompletions();

    expect(script).toContain("Register-ArgumentCompleter -Native -CommandName executor");
    expect(script).toContain("& executor @arguments --help");
    expect(script).toContain("GLOBAL FLAGS");
    expect(script).toContain("SUBCOMMANDS");
    expect(script).toContain("[regex]::Escape($previous)");
    expect(script).toContain("$choices += 'pwsh'");
    expect(script).toContain("^\\s+(--[a-z0-9-]+)");
    expect(script).toContain("^\\s+([a-z][a-z0-9-]*)");
  });
});
