// ---------------------------------------------------------------------------
// GoogleProductPicker "View scopes" data source.
//
// The picker previews the OAuth consent BEFORE connecting by feeding each
// selected preset's representative scopes through `googleOAuthConsentBatches`.
// These tests pin that bridge: the consent-scope map is complete and the
// previewed batches match what the user is about to grant (core services
// collapsed into one batch; admin/cloud services split out).
// ---------------------------------------------------------------------------

import { expect, it } from "@effect/vitest";

import {
  googleAudienceWarningsForUrls,
  googleOAuthConsentScopes,
  googleOAuthConsentScopesForPreset,
  googleOpenApiPresets,
  googlePresetForDiscoveryUrl,
  type GoogleOpenApiPreset,
} from "./presets";
import { googleOAuthConsentBatches } from "./oauth-batches";
import { compactGoogleOAuthScopes } from "./oauth-scopes";

const batchInputsFor = (presetIds: readonly string[]) =>
  googleOpenApiPresets
    .filter((preset: GoogleOpenApiPreset) => presetIds.includes(preset.id))
    .map((preset: GoogleOpenApiPreset) => ({
      id: preset.id,
      name: preset.name,
      oauthAudience: preset.oauthAudience,
      scopes: googleOAuthConsentScopesForPreset(preset.id),
    }));

it("declares representative consent scopes for every Google preset", () => {
  for (const preset of googleOpenApiPresets) {
    expect(googleOAuthConsentScopesForPreset(preset.id).length).toBeGreaterThan(0);
  }
  // No stray keys for presets that no longer exist.
  const presetIds = new Set(googleOpenApiPresets.map((preset) => preset.id));
  for (const key of Object.keys(googleOAuthConsentScopes)) {
    expect(presetIds.has(key)).toBe(true);
  }
});

it("previews the featured selection as a single core-services consent batch", () => {
  const featuredIds = googleOpenApiPresets
    .filter((preset: GoogleOpenApiPreset) => preset.featured)
    .map((preset: GoogleOpenApiPreset) => preset.id);

  const batches = googleOAuthConsentBatches(batchInputsFor(featuredIds));

  // The featured presets are all standard-user, so they collapse into one batch.
  expect(batches.map((batch) => batch.id)).toEqual(["google-core"]);
  expect(batches[0]?.apiScopes).toEqual([
    "https://www.googleapis.com/auth/calendar",
    "https://mail.google.com/",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
  ]);
});

it("maps stored Discovery URLs back to presets and flags caution-tier audiences", () => {
  // A normalized stored URL (trailing slash, sorted query) still resolves.
  expect(
    googlePresetForDiscoveryUrl("https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest/")
      ?.id,
  ).toBe("google-calendar");

  // A bundle of only standard/advanced APIs raises no audience warning.
  expect(
    googleAudienceWarningsForUrls([
      "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
      "https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest",
    ]),
  ).toEqual([]);

  // Admin-only (Chat) and unsupported-consent (Keep) APIs both flag.
  expect(
    [
      ...googleAudienceWarningsForUrls([
        "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
        "https://www.googleapis.com/discovery/v1/apis/chat/v1/rest",
        "https://keep.googleapis.com/$discovery/rest?version=v1",
      ]),
    ].sort(),
  ).toEqual(["unsupported-user", "workspace-admin"]);
});

it("previews a consent set that matches what the bundle persists (compaction parity)", () => {
  // The bundle converter runs the unioned Discovery scopes through
  // `compactGoogleOAuthScopes` before persisting the auth template. The picker
  // preview must agree: feeding every preview batch's scopes back through the
  // same compaction is idempotent (already collapsed/filtered), so the previewed
  // grant is exactly the persisted/requested grant.
  const allPresetIds = googleOpenApiPresets.map((preset: GoogleOpenApiPreset) => preset.id);
  const batches = googleOAuthConsentBatches(batchInputsFor(allPresetIds));
  for (const batch of batches) {
    expect(compactGoogleOAuthScopes(batch.apiScopes)).toEqual([...batch.apiScopes]);
  }
});

it("splits a mixed selection into core + per-service consent batches", () => {
  const batches = googleOAuthConsentBatches(
    batchInputsFor(["google-calendar", "google-youtube-data", "google-bigquery"]),
  );

  expect(batches.map((batch) => ({ id: batch.id, apiScopes: batch.apiScopes }))).toEqual([
    {
      id: "google-core",
      apiScopes: ["https://www.googleapis.com/auth/calendar"],
    },
    {
      id: "google-youtube-data",
      apiScopes: ["https://www.googleapis.com/auth/youtube"],
    },
    {
      id: "google-cloud",
      apiScopes: ["https://www.googleapis.com/auth/bigquery"],
    },
  ]);
});
