import { describe, expect, it } from "@effect/vitest";
import type { HealthCheckCandidate } from "@executor-js/sdk/shared";
import { renderToStaticMarkup } from "react-dom/server";

import { HealthCheckConfigFields, initialHealthCheckOperation } from "./health-check-editor";

const candidate = (
  operation: string,
  overrides: Partial<HealthCheckCandidate> = {},
): HealthCheckCandidate => ({
  operation,
  method: "get",
  requiredArgCount: 0,
  destructive: false,
  ...overrides,
});

describe("initialHealthCheckOperation", () => {
  const tool = candidate("whoami", { method: "mcp", explicitSelectionOnly: true });

  it("never preselects a candidate that must be picked explicitly", () => {
    expect(initialHealthCheckOperation(null, [tool])).toBe("");
    expect(initialHealthCheckOperation(null, [tool, candidate("me")])).toBe("me");
  });

  it("keeps the saved operation and the first HTTP candidate default", () => {
    expect(initialHealthCheckOperation({ operation: "whoami" }, [tool])).toBe("whoami");
    expect(initialHealthCheckOperation({ operation: "gone" }, [])).toBe("gone");
    expect(initialHealthCheckOperation(null, [candidate("first"), candidate("second")])).toBe(
      "first",
    );
    expect(initialHealthCheckOperation(null, [])).toBe("");
  });
});

describe("HealthCheckConfigFields arguments", () => {
  const render = (selected: HealthCheckCandidate, jsonArgs = "") =>
    renderToStaticMarkup(
      <HealthCheckConfigFields
        candidates={[selected]}
        selected={selected}
        operation={selected.operation}
        onOperationChange={() => undefined}
        identityField=""
        onIdentityFieldChange={() => undefined}
        args={{}}
        onArgChange={() => undefined}
        jsonArgs={jsonArgs}
        onJsonArgsChange={() => undefined}
        idPrefix="hc"
      />,
    );

  it("edits a tool's arguments as one JSON object, flagging a non-object", () => {
    const tool = candidate("search", {
      method: "mcp",
      jsonArguments: true,
      requiredArgCount: 1,
      parameters: [
        { name: "query", location: "argument", required: true },
        { name: "limit", location: "argument", required: false },
      ],
    });
    const markup = render(tool, '{"query": "a"}');
    expect(markup.match(/<textarea/g)).toHaveLength(1);
    expect(markup).toContain("Arguments (JSON)");
    expect(markup).toContain("Takes query (required), limit.");
    expect(markup).not.toContain("hc-arg-query");
    expect(markup).not.toContain('role="alert"');
    expect(render(tool, "[1]")).toContain("Enter the arguments as a JSON object.");
  });

  it("keeps the HTTP request body editor", () => {
    const markup = render(
      candidate("list", {
        method: "post",
        parameters: [{ name: "body", location: "body", required: false }],
      }),
    );
    expect(markup).toContain('aria-label="Request body (JSON)"');
    expect(markup).not.toContain("Arguments (JSON)");
  });
});
