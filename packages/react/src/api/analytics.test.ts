import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  setAnalyticsClient,
  trackEvent,
  type AnalyticsEventName,
  type AnalyticsEvents,
} from "./analytics";

afterEach(() => {
  setAnalyticsClient(null);
});

describe("analytics seam", () => {
  it("is a no-op when no client is mounted", () => {
    expect(() => trackEvent("integration_connect_dialog_opened")).not.toThrow();
  });

  it("forwards name and properties to the mounted client", () => {
    const seen: Array<{ name: AnalyticsEventName; properties: unknown }> = [];
    setAnalyticsClient((name, properties) => {
      seen.push({ name, properties });
    });

    trackEvent("integration_added", { plugin_key: "openapi", integration_slug: "github" });

    expect(seen).toEqual([
      {
        name: "integration_added",
        properties: { plugin_key: "openapi", integration_slug: "github" },
      },
    ]);
  });

  it("sends an empty properties object when none are given", () => {
    const seen: Array<unknown> = [];
    setAnalyticsClient((_name, properties) => {
      seen.push(properties);
    });

    trackEvent("support_opened");

    expect(seen).toEqual([{}]);
  });

  it("stops forwarding after the client is unset", () => {
    let calls = 0;
    setAnalyticsClient(() => {
      calls += 1;
    });
    trackEvent("support_opened");
    setAnalyticsClient(null);
    trackEvent("support_opened");

    expect(calls).toBe(1);
  });

  it("event property values stay primitive (catalog sanity)", () => {
    // Compile-time catalog checks: a property bag is always an object of
    // primitives — no nested user data structures sneak in.
    const sample: AnalyticsEvents["tool_run_submitted"] = {
      integration_slug: "github",
      tool_name: "issues_list",
      args_mode: "form",
      result: "completed",
      is_error: false,
    };
    expect(Object.values(sample).every((v) => typeof v !== "object")).toBe(true);
  });
});
