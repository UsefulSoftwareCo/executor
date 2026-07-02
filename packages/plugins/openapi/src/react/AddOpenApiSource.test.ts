import { describe, expect, it } from "@effect/vitest";

import { baseUrlFromSpecInput } from "./AddOpenApiSource";

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
