import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import { OAuthStartError } from "@executor-js/sdk/shared";

import { adminBlockFrom, adminBlockFromExit, adminBlockReference } from "./oauth-admin-block";

// The claim these tests defend is a product claim, not a parsing one: a console
// may only withdraw the interactive route when the identity provider actually
// refused under policy. Reading it wrong in one direction strands a user with a
// recoverable error and no retry; in the other, it walks them around the exact
// control the enterprise just exercised.

const denial = new OAuthStartError({
  message: "Your organization does not permit this server.",
  blockedByAdmin: true,
  oauthErrorCode: "invalid_target",
});

describe("adminBlockFrom", () => {
  it("reads the verdict off the typed field", () => {
    expect(adminBlockFrom(denial)).toEqual({
      message: "Your organization does not permit this server.",
      oauthErrorCode: "invalid_target",
    });
  });

  it("carries a null reference when the provider returned no code", () => {
    expect(
      adminBlockFrom(new OAuthStartError({ message: "Refused.", blockedByAdmin: true }))
        ?.oauthErrorCode,
    ).toBeNull();
  });

  it("leaves an ordinary start failure alone", () => {
    // No verdict means the interactive route stays open — an expired app, a
    // bad endpoint, a network fault are all things a retry can fix.
    expect(
      adminBlockFrom(new OAuthStartError({ message: "Failed to reach the token endpoint." })),
    ).toBeNull();
  });

  it("does not treat an explicitly-false verdict as a denial", () => {
    expect(
      adminBlockFrom(new OAuthStartError({ message: "Refused.", blockedByAdmin: false })),
    ).toBeNull();
  });

  it("never infers a denial from the wording of a message", () => {
    // The whole reason the field exists. A message that says the words is
    // still not a verdict, and a console that matched on text would start
    // withdrawing the retry for failures the user could have recovered from.
    expect(
      adminBlockFrom(
        new OAuthStartError({ message: "blocked by admin: your organization declined" }),
      ),
    ).toBeNull();
  });

  it("finds the verdict through the popup flow's one level of wrapping", () => {
    // `openAuthorization` rejects with its own error carrying the server's
    // failure as `cause`; the verdict has to survive that hop or the modal
    // sees only a sentence.
    expect(adminBlockFrom({ message: "Failed to start sign-in", cause: denial })).toEqual({
      message: "Your organization does not permit this server.",
      oauthErrorCode: "invalid_target",
    });
  });

  it("does not go hunting down a cause chain", () => {
    // One level is the contract. A chain is not a search space: something
    // deeper is not this connect's verdict.
    expect(adminBlockFrom({ cause: { cause: denial } })).toBeNull();
  });

  it("reads nothing out of values that are not start failures", () => {
    expect(adminBlockFrom(null)).toBeNull();
    expect(adminBlockFrom("blocked")).toBeNull();
    expect(adminBlockFrom({ blockedByAdmin: true })).toBeNull();
  });
});

describe("adminBlockFromExit", () => {
  it("reads the verdict out of a failed exit", () => {
    expect(adminBlockFromExit(Exit.fail(denial))?.oauthErrorCode).toBe("invalid_target");
  });

  it("has no verdict for a successful exit", () => {
    expect(adminBlockFromExit(Exit.succeed({ status: "connected" }))).toBeNull();
  });
});

describe("adminBlockReference", () => {
  it("quotes the provider's own code so a member can trace it", () => {
    expect(adminBlockReference({ message: "…", oauthErrorCode: "invalid_target" })).toBe(
      "Reference: invalid_target",
    );
  });

  it("shows no reference line when there is no code to show", () => {
    expect(adminBlockReference({ message: "…", oauthErrorCode: null })).toBeNull();
  });
});
