const BOUND = "railSpyBound";
const LINE_PX = 120;

export function initRailSpy(root: HTMLElement): void {
  if (root.dataset[BOUND] === "1") return;
  root.dataset[BOUND] = "1";

  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>(".rail__toc a[href^='#']"));
  if (links.length === 0) return;

  const pairs: Array<{ section: HTMLElement; link: HTMLAnchorElement }> = [];
  for (const link of links) {
    const id = decodeURIComponent(link.getAttribute("href")!.slice(1));
    const section = id ? document.getElementById(id) : null;
    if (section == null) {
      const row = link.closest<HTMLElement>(".rail__toc-item") ?? link;
      row.hidden = true;
      continue;
    }
    pairs.push({ section, link });
  }
  if (pairs.length === 0) return;

  const apply = (): void => {
    const line = window.scrollY + LINE_PX;
    const atBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;

    let active: HTMLElement | null = null;
    if (atBottom) {
      active = pairs[pairs.length - 1]!.section;
    } else {
      for (const { section } of pairs) {
        if (section.offsetTop <= line) active = section;
        else break;
      }
    }

    if (active == null) {
      delete root.dataset.activeSection;
    } else {
      root.dataset.activeSection = active.id;
    }
    for (const { section, link } of pairs) {
      if (section === active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  };

  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  };

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("hashchange", schedule);
  apply();
}
