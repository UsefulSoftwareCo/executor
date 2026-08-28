import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Settings page scaffold
//
// Every top-level settings view (Integrations, Policies, API keys, Providers,
// Organization, Billing) shares one column width, gutter, and heading scale so
// the content edge and title don't shift as you move between tabs. Use these
// instead of hand-rolling the `mx-auto max-w-* px-* py-*` wrapper per page.
// ---------------------------------------------------------------------------

type PageContainerProps = React.ComponentProps<"div"> & {
  /**
   * Content width variants for pages whose information architecture genuinely
   * needs more room than the settings column.
   */
  variant?: "default" | "wide";
};

const PAGE_CONTAINER_WIDTHS = {
  default: "max-w-4xl",
  wide: "max-w-6xl",
} as const;

function PageContainer({ className, children, variant = "default", ...props }: PageContainerProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-slot="page-container">
      <div
        className={cn(
          "mx-auto px-6 py-10 lg:px-8 lg:py-14",
          PAGE_CONTAINER_WIDTHS[variant],
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}

function PageHeader({
  title,
  description,
  actions,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Optional trailing controls (buttons) aligned to the heading baseline. */
  actions?: React.ReactNode;
}) {
  return (
    <div
      data-slot="page-header"
      className={cn("mb-10 flex items-start justify-between gap-4", className)}
      {...props}
    >
      <div className="min-w-0">
        <h1 className="font-display text-[2rem] tracking-tight leading-none text-foreground">
          {title}
        </h1>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export { PageContainer, PageHeader };
