import { expect, it } from "@effect/vitest";

import {
  compactGoogleOAuthScopes,
  filterGoogleUserConsentOAuthScopes,
} from "./google-oauth-scopes";

it("filters Google scopes that cannot be shown on a user OAuth consent screen", () => {
  expect(
    filterGoogleUserConsentOAuthScopes([
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/chat.app.messages.readonly",
      "https://www.googleapis.com/auth/chat.bot",
      "https://www.googleapis.com/auth/chat.import",
      "https://www.googleapis.com/auth/chat.messages.readonly",
      "https://www.googleapis.com/auth/keep",
      "https://www.googleapis.com/auth/keep.readonly",
    ]),
  ).toEqual([
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/chat.messages.readonly",
  ]);
});

it("compacts Google OAuth scopes after filtering user-consent-incompatible scopes", () => {
  expect(
    compactGoogleOAuthScopes([
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "openid",
      "https://www.googleapis.com/auth/chat.app.spaces",
      "https://www.googleapis.com/auth/keep.readonly",
    ]),
  ).toEqual(["https://mail.google.com/", "email", "profile", "openid"]);
});
