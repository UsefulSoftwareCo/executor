import { describe, expect, it } from "@effect/vitest";
import { type Integration, IntegrationSlug } from "@executor-js/sdk/shared";

import {
  groupIntegrations,
  integrationFamily,
  type IntegrationFamilyGroup,
} from "./integration-grouping";

const integration = (slug: string, kind: string, name = slug, family?: string): Integration => ({
  slug: IntegrationSlug.make(slug),
  name,
  description: name,
  kind,
  canRemove: true,
  canRefresh: true,
  authMethods: [],
  ...(family ? { family } : {}),
});

describe("groupIntegrations", () => {
  it("collapses multi-member config families under one umbrella", () => {
    const items = groupIntegrations([
      integration("google_calendar", "openapi", "Google Calendar", "google"),
      integration("google_gmail", "openapi", "Gmail", "google"),
      integration("google_drive", "openapi", "Google Drive", "google"),
    ]);

    expect(items).toHaveLength(1);
    const group = items[0] as IntegrationFamilyGroup;
    expect(group.type).toBe("group");
    expect(group.family).toBe("google");
    expect(group.label).toBe("Google");
    expect(group.members.map((m) => String(m.slug))).toEqual([
      "google_calendar",
      "google_gmail",
      "google_drive",
    ]);
  });

  it("leaves integrations without config family ungrouped", () => {
    const items = groupIntegrations([
      integration("stripe", "openapi", "Stripe"),
      integration("sentry", "mcp", "Sentry"),
    ]);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.type)).toEqual(["single", "single"]);
  });

  it("renders a lone family member flat", () => {
    const items = groupIntegrations([
      integration("google_calendar", "openapi", "Google Calendar", "google"),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("single");
  });

  it("places each group where its first member appeared", () => {
    const items = groupIntegrations([
      integration("stripe", "openapi", "Stripe"),
      integration("google_calendar", "openapi", "Google Calendar", "google"),
      integration("microsoft_mail", "openapi", "Outlook Mail", "microsoft"),
      integration("google_gmail", "openapi", "Gmail", "google"),
      integration("microsoft_calendar", "openapi", "Outlook Calendar", "microsoft"),
      integration("sentry", "mcp", "Sentry"),
    ]);

    expect(
      items.map((item) => (item.type === "group" ? `group:${item.family}` : "single")),
    ).toEqual(["single", "group:google", "group:microsoft", "single"]);
  });

  it("does not group from integration kind alone", () => {
    expect(
      integrationFamily(integration("google_calendar", "google", "Google Calendar")),
    ).toBeNull();
  });
});
