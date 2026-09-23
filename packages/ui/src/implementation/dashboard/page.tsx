import type { ReactNode } from "react";

/** Shared dashboard width and responsive gutters, independent of a page's content or data state. */
export function PageFrame({ children }: { readonly children: ReactNode }) {
  return (
    <section className="page mx-auto my-0 w-full min-w-0 max-w-315 shrink-0 [padding:24px_24px_48px] max-[1000px]:[padding:20px_20px_40px] max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      {children}
    </section>
  );
}

/** Consistent page heading; compose product-owned actions as children beside the title. */
export function PageHeader({
  title,
  description,
  count,
  children,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly count?: number;
  readonly children?: ReactNode;
}) {
  return (
    <header className="page-heading mb-4.5 flex min-h-12 flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1 basis-60 wrap-anywhere">
        <h1 className="text-[22px] font-semibold leading-[1.35] tracking-[-0.035em]">
          {title}
          {count !== undefined && (
            <span className="ml-2 align-middle font-mono text-[13px] font-normal text-muted-foreground">
              {count}
            </span>
          )}
        </h1>
        {description && (
          <p className="mt-1.25 text-[13px] leading-[1.6] text-muted-foreground">{description}</p>
        )}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}
