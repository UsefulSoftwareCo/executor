import { describe, expect, it } from "@effect/vitest";

import { ARTIFACT_PREVIEW_MARKUP_LIMIT, sanitizeArtifactPreviewMarkup } from "./artifact-preview";

describe("sanitizeArtifactPreviewMarkup", () => {
  describe("the shape it is written against", () => {
    it("keeps the structure and classes a smoke render produces", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div class="rounded-lg border p-4"><h2 class="text-sm">Revenue</h2>' +
          '<div class="h-4 w-24 animate-pulse rounded bg-muted"></div></div>',
      );
      expect(result).toBe(
        '<div class="rounded-lg border p-4"><h2 class="text-sm">Revenue</h2>' +
          '<div class="h-4 w-24 animate-pulse rounded bg-muted"></div></div>',
      );
    });

    it("keeps a chart's svg geometry", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<svg viewBox="0 0 100 40"><g><path d="M0,10 L20,5 L40,18" stroke="currentColor" ' +
          'stroke-width="1.5" fill="none"></path></g></svg>',
      );
      expect(result).toContain('viewbox="0 0 100 40"');
      expect(result).toContain('d="M0,10 L20,5 L40,18"');
      expect(result).toContain('stroke-width="1.5"');
    });

    it("keeps table composition", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<table><thead><tr><th colspan="2">Name</th></tr></thead>' +
          "<tbody><tr><td>Row</td></tr></tbody></table>",
      );
      expect(result).toBe(
        '<table><thead><tr><th colspan="2">Name</th></tr></thead>' +
          "<tbody><tr><td>Row</td></tr></tbody></table>",
      );
    });

    it("keeps React's HTML comment markers out without eating the content around them", () => {
      // `renderToReadableStream` emits `<!--$-->`/`<!--/$-->` around Suspense
      // boundaries. They are comments, so they go; their content stays.
      const result = sanitizeArtifactPreviewMarkup(
        "<div><!--$--><span>Loading</span><!--/$--></div>",
      );
      expect(result).toBe("<div><span>Loading</span></div>");
    });
  });

  describe("scripts", () => {
    it("removes a script element AND its body", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div>before<script>fetch("https://evil.test")</script>after</div>',
      );
      expect(result).toBe("<div>beforeafter</div>");
      expect(result).not.toContain("fetch");
      expect(result).not.toContain("evil.test");
    });

    it("removes a style element AND its body", () => {
      const result = sanitizeArtifactPreviewMarkup(
        "<div><style>body{background:url(https://evil.test/beacon)}</style>ok</div>",
      );
      expect(result).toBe("<div>ok</div>");
      expect(result).not.toContain("evil.test");
    });

    it("does not let a nested tag close the skip early", () => {
      const result = sanitizeArtifactPreviewMarkup(
        "<div><script><div>still inside</div>payload</script>after</div>",
      );
      expect(result).toBe("<div>after</div>");
      expect(result).not.toContain("still inside");
      expect(result).not.toContain("payload");
    });

    it("removes noscript, template and object with their contents", () => {
      for (const tag of ["noscript", "template", "object"]) {
        const result = sanitizeArtifactPreviewMarkup(`<div><${tag}>hidden</${tag}>kept</div>`);
        expect(result).toBe("<div>kept</div>");
      }
    });
  });

  describe("event handlers", () => {
    it("strips every on* attribute", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div onclick="steal()" onmouseover="steal()" onerror="steal()" class="p-2">x</div>',
      );
      expect(result).toBe('<div class="p-2">x</div>');
      expect(result).not.toContain("steal");
    });

    it("strips handlers whatever their casing", () => {
      const result = sanitizeArtifactPreviewMarkup('<div OnClick="steal()">x</div>');
      expect(result).not.toContain("steal");
    });

    it("strips a handler whose value contains a closing angle bracket", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div onclick="if (a > b) steal()" class="keep">x</div>',
      );
      expect(result).toBe('<div class="keep">x</div>');
      expect(result).not.toContain("steal");
    });
  });

  describe("external references", () => {
    it("drops img entirely, so no request is ever made", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div><img src="https://evil.test/beacon.png" />ok</div>',
      );
      expect(result).toBe("<div>ok</div>");
      expect(result).not.toContain("evil.test");
    });

    it("drops iframe and its content", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div><iframe src="https://evil.test"></iframe>ok</div>',
      );
      expect(result).toBe("<div>ok</div>");
    });

    it("unwraps an anchor but keeps its text, dropping the href", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div><a href="https://evil.test">Dashboard</a></div>',
      );
      expect(result).toBe("<div>Dashboard</div>");
      expect(result).not.toContain("evil.test");
    });

    it("drops a style declaration that can fetch", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div style="background:url(https://evil.test/x)" class="keep">x</div>',
      );
      expect(result).toBe('<div class="keep">x</div>');
      expect(result).not.toContain("evil.test");
    });

    it("drops a url() smuggled into an allowed style property", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div style="width:url(https://evil.test/x)" class="keep">x</div>',
      );
      expect(result).toBe('<div class="keep">x</div>');
      expect(result).not.toContain("evil.test");
    });

    it("drops position and transform, which would escape the card", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div style="position:fixed;z-index:9999;width:50%">x</div>',
      );
      expect(result).toBe('<div style="width:50%">x</div>');
    });

    it("drops an svg url() paint that points anywhere but a local id", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<svg viewBox="0 0 10 10"><rect fill="url(https://evil.test/x)" width="10" /></svg>',
      );
      expect(result).toContain("<rect");
      expect(result).not.toContain("evil.test");
      expect(result).not.toContain("fill=");
    });

    it("drops link and meta", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div><link rel="stylesheet" href="https://evil.test/x.css" /><meta charset="utf-8" />ok</div>',
      );
      expect(result).toBe("<div>ok</div>");
    });

    it("neutralises a javascript: scheme wherever it lands", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div class="javascript:alert(1)"><span fill="javascript:alert(1)">x</span></div>',
      );
      expect(result).not.toContain("javascript:");
    });
  });

  describe("interactive elements", () => {
    it("unwraps a button, keeping its label", () => {
      const result = sanitizeArtifactPreviewMarkup("<div><button>Refresh</button></div>");
      expect(result).toBe("<div>Refresh</div>");
    });

    it("drops form controls", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<div><form action="https://evil.test"><input name="x" /></form>ok</div>',
      );
      expect(result).toBe("<div>ok</div>");
      expect(result).not.toContain("evil.test");
    });
  });

  describe("ids", () => {
    it("namespaces ids so a preview cannot collide with the host document", () => {
      const result = sanitizeArtifactPreviewMarkup('<div id="root">x</div>');
      expect(result).toBe('<div id="artifact-preview-root">x</div>');
    });

    it("rewrites local paint references in step with the ids", () => {
      const result = sanitizeArtifactPreviewMarkup(
        '<svg><defs><linearGradient id="grad"><stop offset="0" /></linearGradient></defs>' +
          '<rect fill="url(#grad)" width="10" height="10" /></svg>',
      );
      expect(result).toContain('id="artifact-preview-grad"');
      expect(result).toContain('fill="url(#artifact-preview-grad)"');
    });
  });

  describe("text and entities", () => {
    it("keeps escaped markup escaped, and does not let it re-enter as an element", () => {
      const result = sanitizeArtifactPreviewMarkup(
        "<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>",
      );
      expect(result).toBe("<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>");
      expect(result).not.toContain("<script");
    });

    it("is idempotent, so a re-sanitized preview is unchanged", () => {
      // The input is already-escaped HTML. Escaping `&` a second time would
      // turn `&amp;` into `&amp;amp;` and corrupt every Tailwind arbitrary
      // variant in the markup.
      const once = sanitizeArtifactPreviewMarkup("<div>a &lt; b &amp;&amp; c</div>");
      expect(once).toBe("<div>a &lt; b &amp;&amp; c</div>");
      expect(sanitizeArtifactPreviewMarkup(once ?? "")).toBe(once);
    });

    it("preserves a Tailwind arbitrary variant containing an ampersand", () => {
      // What React writes for `[&_.recharts-layer]:outline-hidden`.
      const result = sanitizeArtifactPreviewMarkup(
        '<div class="[&amp;_.recharts-layer]:outline-hidden">x</div>',
      );
      expect(result).toBe('<div class="[&amp;_.recharts-layer]:outline-hidden">x</div>');
      expect(result).not.toContain("&amp;amp;");
    });
  });

  describe("size", () => {
    it("returns null past the cap", () => {
      const huge = `<div>${"x".repeat(ARTIFACT_PREVIEW_MARKUP_LIMIT + 1)}</div>`;
      expect(sanitizeArtifactPreviewMarkup(huge)).toBeNull();
    });

    it("keeps markup just under the cap", () => {
      const body = "x".repeat(1000);
      expect(sanitizeArtifactPreviewMarkup(`<div>${body}</div>`)).toBe(`<div>${body}</div>`);
    });
  });

  describe("nothing usable", () => {
    it("returns null for empty input", () => {
      expect(sanitizeArtifactPreviewMarkup("")).toBeNull();
    });

    it("returns null when everything sanitized away", () => {
      expect(sanitizeArtifactPreviewMarkup("<script>alert(1)</script>")).toBeNull();
    });

    it("returns null for whitespace-only structure", () => {
      expect(sanitizeArtifactPreviewMarkup("<div>   </div>")).toBeNull();
    });

    it("keeps a purely geometric render that has no text at all", () => {
      // A chart-only artifact is a real preview even with zero text nodes.
      const result = sanitizeArtifactPreviewMarkup(
        '<div><svg viewBox="0 0 10 10"><rect width="10" height="10" /></svg></div>',
      );
      expect(result).not.toBeNull();
      expect(result).toContain("<svg");
    });
  });

  describe("malformed input", () => {
    it("does not hang or throw on an unterminated tag", () => {
      expect(() => sanitizeArtifactPreviewMarkup('<div class="x')).not.toThrow();
    });

    it("does not hang or throw on an unterminated comment", () => {
      expect(() => sanitizeArtifactPreviewMarkup("<div><!-- unterminated")).not.toThrow();
    });

    it("balances a self-closing non-void element", () => {
      expect(sanitizeArtifactPreviewMarkup("<div><span /></div>")).toBe("<div><span></span></div>");
    });
  });
});
