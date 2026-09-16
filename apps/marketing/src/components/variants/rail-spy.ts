// Scroll-spy for the sidebar rail.
//
// The rail renders a `.rail__toc` whose links point at the page's section
// anchors. This marks the link for the section the reader is in with
// `aria-current="true"`, and mirrors the id onto the aside as
// `data-active-section` so CSS can react without extra classes.
//
// "The section the reader is in" is the last section whose top has crossed a
// line a little below the top of the viewport. An anchor jump lands a section
// exactly on that line, so a clicked link is always the one that lights up,
// even for short sections near the end of the page. At the very bottom of the
// page the final section wins, since the reader cannot scroll any further.
//
// Tolerates missing sections and stays idempotent if the initializer runs
// again on the same element.

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
      row.style.display = "none";
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
