import { describe, expect, it } from "@effect/vitest";

import { oauthSetupDocument } from "./oauth-setup";

const setup = {
  title: "Connect GitHub",
  description: "Choose repositories.",
  actionLabel: "Install GitHub App",
  actionUrl: "https://github.com/apps/example/installations/new",
};

describe("OAuth setup document", () => {
  it("escapes host text and query parameters without exposing markup or a referrer", () => {
    const html = oauthSetupDocument({
      setup: { ...setup, title: '<script>alert("title")</script>', description: "<img src=x>" },
      authorizationUrl: "https://github.com/login/oauth/authorize?state=a&client_id=b",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("?state=a&amp;client_id=b");
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it("refuses executable or malformed link targets", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,hello", "not a URL"]) {
      expect(
        oauthSetupDocument({
          setup: { ...setup, actionUrl: url },
          authorizationUrl: "https://github.com/",
        }),
      ).toContain("Connection setup unavailable");
      expect(oauthSetupDocument({ setup, authorizationUrl: url })).toContain(
        "Connection setup unavailable",
      );
    }
  });
});
