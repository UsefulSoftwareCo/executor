/**
 * The sidebar's news block, after PlanetScale's changelog block: a small tag and one line of plain
 * text above the footer's divider, with no card around it, and an optional text link under them.
 * The line wraps as far as its text needs, so a long version is never cut off. The shell shows it
 * in place of the resource links and leaves it out of the icon rail.
 */
import type { ReactNode } from "react";

export function SidebarNews({
  tag,
  children,
  action,
  status = false,
}: {
  /** The pill's text, such as "Update ready". */
  readonly tag: string;
  /** The one line under the tag. */
  readonly children: ReactNode;
  /** A text link under the line, styled with `sidebarNewsActionClass`. */
  readonly action?: ReactNode;
  /** A passing state such as a download, which assistive technology reads as a status. */
  readonly status?: boolean;
}) {
  return (
    <section
      aria-label={status ? undefined : tag}
      role={status ? "status" : undefined}
      className="sidebar-update grid justify-items-start gap-2 px-[10px]"
    >
      <div className="grid justify-items-start gap-1.5">
        <span className="sidebar-news-tag rounded-md border bg-muted px-1.5 py-px text-[10px] leading-[15px] text-muted-foreground">
          {tag}
        </span>
        <span className="sidebar-news-line text-[12px] leading-snug text-foreground [overflow-wrap:anywhere]">
          {children}
        </span>
      </div>
      {action}
    </section>
  );
}

/** The block's action as a text link, such as "Restart to update". */
export const sidebarNewsActionClass =
  "inline-flex items-center gap-1 rounded-sm text-[12px] font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50";
