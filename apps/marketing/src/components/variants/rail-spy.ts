// Scroll-spy for the sidebar rail variants.
//
// Each rail renders a `.rail__toc` whose links point at the page's section
// anchors. This marks the link for the section currently in the reading band
// with `aria-current="true"`, and mirrors the id onto the aside as
// `data-active-section` so CSS can react without extra classes.
//
// Rails can be mounted inside a hidden picker wrapper, and the picker can swap
// which one is visible at any time. So: bind unconditionally (an observer on a
// hidden subtree is cheap and harmless), tolerate missing sections, and stay
// idempotent if the initializer runs again on the same element.

const BOUND = "railSpyBound";

export function initRailSpy(root: HTMLElement): void {
  if (root.dataset[BOUND] === "1") return;
  root.dataset[BOUND] = "1";

  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>(".rail__toc a[href^='#']"));
  if (links.length === 0) return;

  // Pair each link with its section. A link whose target is absent (for
  // example #proof when no proof variant is picked) is hidden, not left
  // pointing at nothing.
  const pairs: Array<{ id: string; link: HTMLAnchorElement }> = [];
  for (const link of links) {
    const id = decodeURIComponent(link.getAttribute("href")!.slice(1));
    // Picker wrappers can hold several copies of a section under one id; only
    // the visible copy ever intersects, so observe all of them.
    const sections = id ? document.querySelectorAll(`[id="${CSS.escape(id)}"]`) : [];
    if (sections.length === 0) {
      const row = link.closest<HTMLElement>(".rail__toc-item") ?? link;
      row.style.display = "none";
      continue;
    }
    pairs.push({ id, link });
  }
  if (pairs.length === 0) return;

  // A target that only exists inside a hidden picker wrapper is not on the
  // page the reader sees; hide its row, and re-check when wrappers toggle.
  const refreshRows = (): void => {
    for (const { id, link } of pairs) {
      const targets = document.querySelectorAll<HTMLElement>(`[id="${CSS.escape(id)}"]`);
      const shown = Array.from(targets).some((t) => t.closest("[hidden]") == null);
      const row = link.closest<HTMLElement>(".rail__toc-item") ?? link;
      row.style.display = shown ? "" : "none";
    }
    // Keep any mono index contiguous over the rows that remain.
    let n = 0;
    for (const { link } of pairs) {
      const row = link.closest<HTMLElement>(".rail__toc-item") ?? link;
      if (row.style.display === "none") continue;
      n += 1;
      const num = row.querySelector<HTMLElement>(".rail__num");
      if (num) num.textContent = String(n).padStart(2, "0");
    }
  };
  refreshRows();
  new MutationObserver(refreshRows).observe(document.body, {
    attributes: true,
    attributeFilter: ["hidden"],
    subtree: true,
  });

  const order = pairs.map((p) => p.id);
  const visible = new Set<string>();

  const apply = (): void => {
    // Topmost visible section wins, so the rail never flickers between two
    // sections that overlap the reading band.
    let activeId: string | null = null;
    for (const id of order) {
      if (visible.has(id)) {
        activeId = id;
        break;
      }
    }
    if (activeId == null) {
      delete root.dataset.activeSection;
    } else {
      root.dataset.activeSection = activeId;
    }
    for (const { id, link } of pairs) {
      if (id === activeId) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      apply();
    },
    { rootMargin: "-40% 0px -55% 0px", threshold: 0 },
  );

  for (const { id } of pairs) {
    for (const section of document.querySelectorAll(`[id="${CSS.escape(id)}"]`)) {
      observer.observe(section);
    }
  }
}
