import type { ReactNode, RefObject } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/dialog.tsx";

const tagClass =
  "sidebar-news-tag rounded-md border bg-muted px-1.5 py-px text-[10px] leading-[15px] text-muted-foreground";
const lineClass =
  "sidebar-news-line text-[12px] leading-snug text-foreground [overflow-wrap:anywhere]";

export function SidebarNews({
  tag,
  children,
  action,
  status = false,
  open,
  buttonRef,
}: {
  readonly tag: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly status?: boolean;
  readonly open?: { readonly label: string; readonly onOpen: () => void };
  readonly buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <section
      aria-label={status ? undefined : tag}
      role={status ? "status" : undefined}
      className="sidebar-update grid justify-items-start gap-2 px-[10px]"
    >
      {open === undefined ? (
        <div className="grid justify-items-start gap-1.5">
          <span className={tagClass}>{tag}</span>
          <span className={lineClass}>{children}</span>
        </div>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          onClick={open.onOpen}
          aria-label={open.label}
          className="sidebar-news-open group -m-1 grid justify-items-start gap-1.5 rounded-md p-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span
            className={`${tagClass} transition-colors group-hover:bg-accent group-hover:text-foreground`}
          >
            {tag}
          </span>
          <span className={lineClass}>{children}</span>
        </button>
      )}
      {action}
    </section>
  );
}

export const sidebarNewsActionClass =
  "inline-flex items-center gap-1 rounded-sm text-[12px] font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function NewsVersion({ version }: { readonly version: string }) {
  return <span className="font-mono text-[11px] text-muted-foreground">v{version}</span>;
}

export interface NewsRelease {
  readonly key: string;
  readonly heading: string;
  readonly mono?: boolean;
  readonly notes: ReadonlyArray<string>;
  readonly url?: { readonly href: string; readonly label: string };
}

export function ReleaseNotesDialog({
  open,
  onOpenChange,
  title,
  description,
  releases,
  action,
  more,
  returnFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly releases: ReadonlyArray<NewsRelease>;
  readonly action?: ReactNode;
  readonly more?: { readonly label: string; readonly url: string };
  readonly returnFocus?: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="release-notes max-h-[85dvh] gap-5 overflow-y-auto sm:max-w-md"
        onCloseAutoFocus={(event) => {
          if (returnFocus?.current == null) return;
          event.preventDefault();
          returnFocus.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {releases.map((release) => (
            <section
              key={release.key}
              aria-label={release.heading}
              className="release-notes-release grid gap-2"
            >
              <h3 className={`text-[13px] font-medium ${release.mono === true ? "font-mono" : ""}`}>
                {release.heading}
              </h3>
              {release.notes.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  No changes were listed for this release.
                </p>
              ) : (
                <ul className="grid gap-1.5 text-[13px] leading-snug">
                  {release.notes.map((note) => (
                    <li key={note} className="flex gap-2">
                      <span
                        aria-hidden
                        className="mt-[0.5em] size-1 shrink-0 rounded-full bg-muted-foreground"
                      />
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              )}
              {release.url !== undefined && (
                <ExternalLink url={release.url.href} label={release.url.label}>
                  Release page
                </ExternalLink>
              )}
            </section>
          ))}
          {more !== undefined && (
            <ExternalLink url={more.url} label={more.label}>
              {more.label}
            </ExternalLink>
          )}
        </div>
        {action !== undefined && <div className="flex justify-end border-t pt-4">{action}</div>}
      </DialogContent>
    </Dialog>
  );
}

function ExternalLink({
  url,
  label,
  children,
}: {
  readonly url: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="inline-flex items-center gap-1 justify-self-start text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {children}
      <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} size={12} aria-hidden />
    </a>
  );
}
