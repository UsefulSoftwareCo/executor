import { expect, it } from "@effect/vitest";

import { googleOAuthConsentBatches } from "./google-oauth-batches";

it("keeps core Google OAuth in one consent batch", () => {
  expect(
    googleOAuthConsentBatches([
      {
        id: "google-gmail",
        name: "Gmail",
        oauthAudience: "standard-user",
        scopes: ["https://mail.google.com/", "https://www.googleapis.com/auth/gmail.send"],
      },
      {
        id: "google-calendar",
        name: "Google Calendar",
        oauthAudience: "standard-user",
        scopes: [
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
      },
    ]),
  ).toEqual([
    {
      id: "google-core",
      label: "Core Google services",
      apiScopes: ["https://mail.google.com/", "https://www.googleapis.com/auth/calendar"],
    },
  ]);
});

it("splits advanced Google OAuth into smaller known-good consent batches", () => {
  expect(
    googleOAuthConsentBatches([
      {
        id: "google-youtube-data",
        name: "YouTube Data",
        oauthAudience: "advanced-user",
        scopes: ["https://www.googleapis.com/auth/youtube"],
      },
      {
        id: "google-classroom",
        name: "Google Classroom",
        oauthAudience: "advanced-user",
        scopes: ["https://www.googleapis.com/auth/classroom.courses"],
      },
      {
        id: "google-apps-script",
        name: "Google Apps Script",
        oauthAudience: "advanced-user",
        scopes: [
          "https://www.googleapis.com/auth/script.projects",
          "https://www.googleapis.com/auth/drive",
        ],
      },
      {
        id: "google-bigquery",
        name: "Google BigQuery",
        oauthAudience: "advanced-user",
        scopes: ["https://www.googleapis.com/auth/bigquery"],
      },
      {
        id: "google-cloud-resource-manager",
        name: "Google Cloud Resource Manager",
        oauthAudience: "advanced-user",
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      },
    ]).map((batch) => ({ id: batch.id, label: batch.label, apiScopes: batch.apiScopes })),
  ).toEqual([
    {
      id: "google-youtube-data",
      label: "YouTube Data",
      apiScopes: ["https://www.googleapis.com/auth/youtube"],
    },
    {
      id: "google-classroom",
      label: "Google Classroom",
      apiScopes: ["https://www.googleapis.com/auth/classroom.courses"],
    },
    {
      id: "google-apps-script",
      label: "Google Apps Script",
      apiScopes: [
        "https://www.googleapis.com/auth/script.projects",
        "https://www.googleapis.com/auth/drive",
      ],
    },
    {
      id: "google-cloud",
      label: "Google Cloud services",
      apiScopes: [
        "https://www.googleapis.com/auth/bigquery",
        "https://www.googleapis.com/auth/cloud-platform",
      ],
    },
  ]);
});
