import { describe, expect, it } from "@effect/vitest";
import * as React from "react";

import {
  AddOpenApiHealthCheckSection,
  baseUrlFromSpecInput,
  openApiPreviewFailureMessage,
} from "./AddOpenApiIntegration";

const visibleText = (node: React.ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join("");
  if (!React.isValidElement(node)) return "";
  const props = node.props as { readonly children?: React.ReactNode };
  return visibleText(props.children);
};

describe("baseUrlFromSpecInput", () => {
  it("defaults URL-hosted specs to their origin", () => {
    expect(baseUrlFromSpecInput("https://app.posthog.com/api/schema/")).toBe(
      "https://app.posthog.com",
    );
  });

  it("does not default raw specs", () => {
    expect(baseUrlFromSpecInput('{"openapi":"3.0.0"}')).toBe("");
  });
});

describe("openApiPreviewFailureMessage", () => {
  it("uses the server message when one is available", () => {
    expect(openApiPreviewFailureMessage("bad yaml")).toBe(
      "Couldn't load or parse this spec: bad yaml",
    );
  });

  it("falls back when the server message is blank", () => {
    expect(openApiPreviewFailureMessage("")).toBe(
      "Couldn't load or parse this spec: unknown error",
    );
  });
});

describe("AddOpenApiHealthCheckSection", () => {
  const candidate = {
    operation: "getCurrentUser",
    method: "get",
    requiredArgCount: 0,
    destructive: false,
    summary: "Get current user",
    parameters: [],
    responseFields: [{ path: "email", type: "string" }],
  };

  it("renders a read-only catalog line when the preset has a health check", () => {
    const text = visibleText(
      AddOpenApiHealthCheckSection({
        presetHealthCheck: { operation: "getCurrentUser" },
        candidates: [candidate],
        selected: candidate,
        operation: "",
        onOperationChange: () => {},
        identityField: "",
        onIdentityFieldChange: () => {},
        args: {},
        onArgChange: () => {},
        disabled: false,
      }),
    );

    expect(text).toContain("getCurrentUser");
    expect(text).toContain("From the catalog. Change it later from the integration page.");
    expect(text).not.toContain("Health check (optional)");
  });

  it("renders the full optional editor when there is no preset health check", () => {
    const text = visibleText(
      AddOpenApiHealthCheckSection({
        candidates: [candidate],
        selected: candidate,
        operation: "getCurrentUser",
        onOperationChange: () => {},
        identityField: "",
        onIdentityFieldChange: () => {},
        args: {},
        onArgChange: () => {},
        disabled: false,
      }),
    );

    expect(text).toContain("Health check (optional)");
    expect(text).toContain("OAuth connections, validity and identity come from the OAuth grant");
    expect(text).not.toContain("From the catalog.");
  });
});
