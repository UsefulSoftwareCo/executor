import { describe, expect, it } from "@effect/vitest";

import { baseUrlFromSpecInput, openApiPreviewFailureMessage } from "./AddOpenApiSource";

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
