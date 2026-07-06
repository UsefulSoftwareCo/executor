import { describe, expect, it } from "@effect/vitest";
import { type Integration, IntegrationSlug } from "@executor-js/sdk/shared";

import {
  groupIntegrations,
  isMultiServiceFamily,
  type IntegrationFamilyGroup,
  type IntegrationSingle,
} from "./integration-grouping";

const integration = (slug: string, kind: string, name = slug): Integration => ({
  slug: IntegrationSlug.make(slug),
  name,
  description: name,
  kind,
  canRemove: true,
  canRefresh: true,
  authMethods: [],
});

describe("groupIntegrations", () => {
  it("collapses a multi-member family under one umbrella", () => {
    const items = groupIntegrations([
      integration("google_calendar", "google", "Google Calendar"),
      integration("google_gmail", "google", "Gmail"),
      integration("google_drive", "google", "Google Drive"),
    ]);

    expect(items).toHaveLength(1);
    const group = items[0] as IntegrationFamilyGroup;
    expect(group.type).toBe("group");
    expect(group.kind).toBe("google");
    expect(group.label).toBe("Google");
    expect(group.members.map((m) => String(m.slug))).toEqual([
      "google_calendar",
      "google_gmail",
      "google_drive",
    ]);
  });

  it("leaves non-family integrations ungrouped", () => {
    const items = groupIntegrations([
      integration("stripe", "openapi", "Stripe"),
      integration("sentry", "mcp", "Sentry"),
    ]);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.type === "single")).toBe(true);
  });

  it("renders a lone family member flat, not as a one-item umbrella", () => {
    const items = groupIntegrations([integration("google_calendar", "google", "Google Calendar")]);
    expect(items).toHaveLength(1);
    expect((items[0] as IntegrationSingle).type).toBe("single");
  });

  it("places each group where its first member first appeared, keeping order stable", () => {
    const items = groupIntegrations([
      integration("stripe", "openapi", "Stripe"),
      integration("google_calendar", "google", "Google Calendar"),
      integration("microsoft_mail", "microsoft", "Outlook Mail"),
      integration("google_gmail", "google", "Gmail"),
      integration("microsoft_calendar", "microsoft", "Outlook Calendar"),
      integration("sentry", "mcp", "Sentry"),
    ]);

    // stripe (single) · Google group (first at index 1) · Microsoft group
    // (first at index 2) · sentry (single). Later family members fold back into
    // their group rather than re-appearing.
    expect(items.map((i) => (i.type === "group" ? `group:${i.kind}` : "single"))).toEqual([
      "single",
      "group:google",
      "group:microsoft",
      "single",
    ]);
    const google = items[1] as IntegrationFamilyGroup;
    const microsoft = items[2] as IntegrationFamilyGroup;
    expect(google.members.map((m) => String(m.slug))).toEqual(["google_calendar", "google_gmail"]);
    expect(microsoft.members.map((m) => String(m.slug))).toEqual([
      "microsoft_mail",
      "microsoft_calendar",
    ]);
  });

  it("keeps custom per-service integrations inside their family group", () => {
    const items = groupIntegrations([
      integration("google_calendar", "google", "Google Calendar"),
      integration("google_custom", "google", "Custom Google API"),
    ]);
    expect(items).toHaveLength(1);
    const group = items[0] as IntegrationFamilyGroup;
    expect(group.members.map((m) => String(m.slug))).toEqual(["google_calendar", "google_custom"]);
  });

  it("recognizes the multi-service family allowlist", () => {
    expect(isMultiServiceFamily("google")).toBe(true);
    expect(isMultiServiceFamily("microsoft")).toBe(true);
    expect(isMultiServiceFamily("openapi")).toBe(false);
  });
});
