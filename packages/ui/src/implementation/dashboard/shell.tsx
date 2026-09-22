import { useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BookOpen01Icon,
  Menu01Icon,
  Message01Icon,
  SidebarLeft01Icon,
  StarIcon,
} from "@hugeicons/core-free-icons";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../components/dialog.tsx";
import { useMediaQuery } from "../hooks/media-query.ts";

const resources = (docsUrl: string) =>
  [
    { label: "Docs", href: docsUrl, icon: BookOpen01Icon },
    {
      label: "Feedback",
      href: "https://github.com/UsefulSoftwareCo/executor/issues",
      icon: Message01Icon,
    },
    {
      label: "Star on GitHub",
      href: "https://github.com/UsefulSoftwareCo/executor",
      icon: StarIcon,
    },
  ] as const;

/** Between the phone layout and a wide screen the rail starts collapsed and can be toggled. */
const mediumViewport = "(min-width: 741px) and (max-width: 1000px)";

/** Sidebar nav link styles, shared by the desktop rail and the phone menu sheet. */
const navigationClass =
  "[&_nav]:grid [&_nav]:gap-0.5 [&_nav_a]:flex [&_nav_a]:items-center [&_nav_a]:py-[6px] [&_nav_a]:px-[8px] [&_nav_a]:gap-2 [&_nav_a]:rounded-[6px] [&_nav_a]:text-[13px] [&_nav_a]:font-medium [&_nav_a]:text-muted-foreground [&_nav_a.active]:bg-accent [&_nav_a.active]:text-foreground [&_nav_a:hover]:bg-accent [&_nav_a:hover]:text-foreground [&_nav_a_>_span]:ml-auto [&_nav_a_>_span]:text-muted-foreground [&_nav_a_>_span]:font-mono [&_nav_a_>_span]:text-[11px] [&_nav_a_>_span]:font-normal";

/**
 * Icon-only rail. Labels stay in the DOM for assistive technology, so they are
 * collapsed with a zero font size rather than removed; icons keep their own size.
 */
const collapsedClass =
  "[&_.sidebar-header]:justify-center [&_.wordmark]:hidden [&_nav_a]:justify-center [&_nav_a]:gap-0! [&_nav_a]:px-0! [&_nav_a]:h-9 [&_nav_a]:text-[0px]! [&_nav_a_>_span]:hidden [&_.sidebar-resource-links]:items-center [&_.sidebar-resource-links]:px-0 [&_.sidebar-resource-links_a]:w-full [&_.sidebar-resource-links_a]:justify-center [&_.sidebar-resource-links_a]:min-h-8 [&_.sidebar-resource-links_a_>_span]:hidden [&_.hosted-identity]:px-0 [&_.organization-trigger]:justify-center [&_.organization-trigger]:px-0 [&_.organization-name]:hidden [&_.organization-chevron]:hidden [&_.session-menu]:justify-center [&_.session-menu]:px-0 [&_.session-name]:hidden [&_.sidebar-version]:hidden";

function ResourceLinks({ docsUrl }: { readonly docsUrl: string }) {
  return (
    <div className="sidebar-resource-links flex flex-col items-start gap-0.5 [padding:0_10px_8px] [&_a]:inline-flex [&_a]:items-center [&_a]:gap-1.5 [&_a]:text-[11px] [&_a]:min-h-6 max-[740px]:[padding:4px_8px_8px] max-[740px]:[&_a]:min-h-10 max-[740px]:[&_a]:text-[13px] max-[740px]:[&_a]:gap-2">
      {resources(docsUrl).map(({ label, href, icon }) => (
        <a key={href} href={href} target="_blank" rel="noopener noreferrer" title={label}>
          <HugeiconsIcon icon={icon} strokeWidth={2} size={13} aria-hidden />
          <span>{label}</span>
        </a>
      ))}
    </div>
  );
}

/**
 * The dashboard layout: a sidebar rail on wide screens, which collapses to an
 * icon rail on medium ones, where it can be toggled either way. On phones the rail
 * becomes a compact top bar (`identity`, or the brand) and a floating Menu pill
 * that opens the same navigation, resource links and footer in a bottom sheet.
 */
export function DashboardShell({
  docsUrl,
  brand,
  navigation,
  identity,
  footer,
  children,
}: {
  /** The owning product chooses same-origin or public documentation. */
  readonly docsUrl: string;
  readonly brand: ReactNode;
  readonly navigation: ReactNode;
  /** Centered in the phone top bar in place of the brand, for example an organization switcher. */
  readonly identity?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const medium = useMediaQuery(mediumViewport);
  const [mediumCollapsed, setMediumCollapsed] = useState(true);
  const collapsed = medium && mediumCollapsed;
  return (
    <div
      className={`shell grid h-dvh max-[740px]:grid-cols-1 max-[740px]:grid-rows-[auto_minmax(0,_1fr)] ${collapsed ? "grid-cols-[60px_minmax(0,_1fr)]" : "grid-cols-[224px_minmax(0,_1fr)] max-[1000px]:grid-cols-[190px_minmax(0,_1fr)]"}`}
    >
      <a
        className="skip-link fixed z-10 top-2 left-2 py-[8px] px-[12px] bg-background border border-border rounded-[6px] [transform:translateY(-150%)] focus:[transform:none]"
        href="#main"
      >
        Skip to content
      </a>
      <aside
        className={`sidebar flex flex-col border-r border-r-border py-0 px-[8px] min-h-0 overflow-y-auto overflow-x-hidden max-[740px]:hidden ${navigationClass} ${collapsed ? collapsedClass : ""}`}
      >
        <div className="sidebar-header flex items-center gap-1 min-h-12 shrink-0">
          {medium ? (
            <button
              type="button"
              className="sidebar-collapse-toggle flex items-center justify-center shrink-0 w-8.5 h-8.5 rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setMediumCollapsed((value) => !value)}
            >
              <HugeiconsIcon
                icon={SidebarLeft01Icon}
                strokeWidth={2}
                size={17}
                aria-hidden
                className={collapsed ? "rotate-180" : undefined}
              />
            </button>
          ) : (
            <span className="flex items-center justify-center shrink-0 size-8.5">
              <img src="/favicon.png" alt="" className="size-6" />
            </span>
          )}
          {brand}
        </div>
        <nav aria-label="Main navigation">{navigation}</nav>
        <div className="sidebar-utilities mt-auto [padding:12px_0_16px] border-t border-t-border text-muted-foreground [&_a:hover]:text-foreground">
          <ResourceLinks docsUrl={docsUrl} />
          {footer}
        </div>
      </aside>
      <header className="shell-bar hidden max-[740px]:flex items-center justify-center gap-2 min-w-0 border-b border-b-border [padding:env(safe-area-inset-top)_max(8px,_env(safe-area-inset-right))_0_max(8px,_env(safe-area-inset-left))] min-h-14 [&_.organization-switcher]:max-w-full [&_.organization-switcher]:min-w-0 [&_.organization-switcher]:p-0 [&_.organization-trigger]:w-auto [&_.organization-trigger]:max-w-full [&_.organization-trigger]:px-[10px]">
        {identity ?? brand}
      </header>
      <main id="main" className="main flex flex-col overflow-y-auto min-w-0 min-h-0" tabIndex={-1}>
        {children}
        <div className="hidden max-[740px]:block h-20 shrink-0" aria-hidden />
      </main>
      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            className="shell-menu-trigger hidden max-[740px]:inline-flex fixed left-1/2 -translate-x-1/2 bottom-[max(16px,_env(safe-area-inset-bottom))] z-40 items-center gap-2 h-11 pl-4 pr-5 rounded-full border border-border bg-background/95 backdrop-blur text-[13px] font-medium text-foreground shadow-[0_2px_5px_#00000010,0_8px_24px_#00000018]"
          >
            <HugeiconsIcon icon={Menu01Icon} strokeWidth={2} size={16} aria-hidden />
            Menu
          </button>
        </DialogTrigger>
        <DialogContent
          showCloseButton={false}
          className={`shell-menu sidebar top-auto bottom-0 left-0 translate-x-0 translate-y-0 w-full max-w-none sm:max-w-none gap-0 rounded-b-none rounded-t-[14px] border-b-0 p-[8px_8px_max(12px,_env(safe-area-inset-bottom))] max-h-[85dvh] overflow-y-auto data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:slide-out-to-bottom-4 data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100 [&_nav_a]:min-h-11 [&_nav_a]:text-[14px] [&_nav_a]:px-[10px] ${navigationClass}`}
          onClickCapture={(event) => {
            // Following a link closes the sheet; the route change happens as usual.
            if ((event.target as Element).closest("a")) setMenuOpen(false);
          }}
        >
          <DialogTitle className="sr-only">Menu</DialogTitle>
          <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-border" aria-hidden />
          <nav aria-label="Main navigation">{navigation}</nav>
          <div className="sidebar-utilities mt-3 [padding:12px_0_0] border-t border-t-border text-muted-foreground [&_a:hover]:text-foreground">
            <ResourceLinks docsUrl={docsUrl} />
            {footer}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
