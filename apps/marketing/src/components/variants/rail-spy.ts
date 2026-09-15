// Scroll-spy for the sidebar rail variants.
//
// Each rail renders a `.rail__toc` whose links point at the page's section
// anchors. This marks the link for the section currently in the reading band
// with `aria-current="true"`, and mirrors the id onto the aside as
// `data-active-section` so CSS can react without extra classes.
//
// Tolerates missing sections and stays idempotent if the initializer runs
// again on the same element.

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
    const section = id ? document.getElementById(id) : null;
    if (section == null) {
      const row = link.closest<HTMLElement>(".rail__toc-item") ?? link;
      row.style.display = "none";
      continue;
    }
    pairs.push({ id, link });
  }
  if (pairs.length === 0) return;

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
    const section = document.getElementById(id);
    if (section != null) observer.observe(section);
  }
}
