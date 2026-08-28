import { describe, expect, it } from "@effect/vitest";

import { changelogBodyToText, renderChangelogHtml } from "./changelog-html";
import { parseChangelog } from "./changelog";

// A changeset is written by whoever opened the pull request, so these run the
// whole path a hostile changeset would take: markdown source → parseChangelog →
// the HTML the page injects, and the text the JSON endpoint publishes.
const bodyOf = (markdown: string): string => {
  const entry = parseChangelog(markdown)[0]?.entries[0];
  if (!entry) throw new Error("expected one parsed entry");
  return entry.body;
};

const release = (item: string) => `# executor\n\n## 9.9.9\n\n### Patch Changes\n\n- ${item}\n`;

describe("renderChangelogHtml", () => {
  it("neutralizes raw HTML embedded in a changeset", () => {
    const html = renderChangelogHtml(
      bodyOf(
        release(
          'Fix the thing. <img src=x onerror="alert(1)"> <script>alert(2)</script><iframe src="https://evil.example"></iframe> Done.',
        ),
      ),
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(2)");
    expect(html.trim()).toBe("<p>Fix the thing.   Done.</p>");
  });

  it("strips event handlers from tags it otherwise allows", () => {
    expect(renderChangelogHtml('<p onclick="alert(1)">Text</p>').trim()).toBe("<p>Text</p>");
  });

  it("drops non-https link targets while keeping the link text", () => {
    const html = renderChangelogHtml(
      bodyOf(
        release(
          "See [docs](javascript:alert(1)) and [more](https://executor.sh/docs) and [http](http://example.com).",
        ),
      ),
    );

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("http://example.com");
    expect(html).toContain('<a href="https://executor.sh/docs" rel="noopener noreferrer"');
    expect(html).toContain(">docs</a>");
  });

  it("keeps ordinary changelog prose intact", () => {
    const html = renderChangelogHtml(
      "**Highlights**\n\n- One thing\n- Another\n\n### Details\n\nUse `<origin>/mcp` for the path.",
    );

    expect(html).toContain("<strong>Highlights</strong>");
    expect(html).toContain("<li>One thing</li>");
    expect(html).toContain("<h3>Details</h3>");
    expect(html).toContain("<code>&lt;origin&gt;/mcp</code>");
  });
});

describe("changelogBodyToText", () => {
  it("publishes no markup for a hostile changeset", () => {
    const text = changelogBodyToText(
      bodyOf(release('Fix it. <img src=x onerror="alert(1)"><script>alert(2)</script> Done.')),
    );

    expect(text).not.toContain("<img");
    expect(text).not.toContain("onerror");
    expect(text).not.toContain("alert");
    expect(text).toBe("Fix it.  Done.");
  });

  it("leaves no tag recoverable from an escaped code span", () => {
    // A code span is escaped by the renderer, so decoding `&lt;` here would put
    // a working `<img>` back into a payload that is meant to carry no markup.
    const text = changelogBodyToText("Never write `<img src=x onerror=alert(1)>` in a changeset.");

    expect(text).not.toContain("<img");
    expect(text).toContain("&lt;img");
  });

  it("flattens markdown to text and decodes ampersands", () => {
    expect(changelogBodyToText("**Integrations & auth** for [`login`](https://executor.sh).")).toBe(
      "Integrations & auth for login.",
    );
  });
});
