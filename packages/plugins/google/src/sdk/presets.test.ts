import { expect, it } from "@effect/vitest";

import { googleCatalog, googleOpenApiPresets, googleStandardUserOAuthPresets } from "./presets";

const FROZEN_GOOGLE_SLUGS = [
  "google_calendar",
  "google_gmail",
  "google_sheets",
  "google_drive",
  "google_docs",
  "google_slides",
  "google_forms",
  "google_tasks",
  "google_people",
  "google_photos_library",
  "google_photos_picker",
  "google_chat",
  "google_keep",
  "google_youtube_data",
  "google_search_console",
  "google_classroom",
  "google_admin_directory",
  "google_admin_reports",
  "google_apps_script",
  "google_bigquery",
  "google_cloud_resource_manager",
] as const;

it("keeps Select all limited to Google services that can use normal user OAuth", () => {
  const standardIds = new Set(googleStandardUserOAuthPresets.map((preset) => preset.id));

  expect(standardIds).toContain("google-calendar");
  expect(standardIds).toContain("google-gmail");
  expect(standardIds).toContain("google-tasks");
  expect(standardIds).toContain("google-people");
  expect(standardIds).toContain("google-search-console");

  expect(standardIds).not.toContain("google-youtube-data");
  expect(standardIds).not.toContain("google-cloud-resource-manager");
  expect(standardIds).not.toContain("google-chat");
  expect(standardIds).not.toContain("google-keep");
  expect(standardIds).not.toContain("google-admin-directory");
  expect(standardIds).not.toContain("google-admin-reports");
});

it("classifies every Google service for bundle OAuth UX", () => {
  expect(
    googleOpenApiPresets.map((preset) => ({
      id: preset.id,
      oauthAudience: preset.oauthAudience,
    })),
  ).toMatchSnapshot();
});

it("exports one catalog row per Google service with stable slugs and per-service OAuth", () => {
  expect(googleCatalog.map((preset) => preset.defaultSlug)).toEqual([...FROZEN_GOOGLE_SLUGS]);
  for (const preset of googleCatalog) {
    expect(preset.family).toBe("google");
    expect(preset.specFormat).toBe("google-discovery");
    expect(preset.defaultSlug).toBeTruthy();
    expect(preset.authTemplate).toHaveLength(1);
    const oauthTemplates = (preset.authTemplate ?? []).filter(
      (template) => template.kind === "oauth2",
    );
    expect(oauthTemplates).toHaveLength(1);
    expect(oauthTemplates[0]?.scopes).toEqual(
      expect.arrayContaining(["openid", "email", "profile"]),
    );
  }
});
