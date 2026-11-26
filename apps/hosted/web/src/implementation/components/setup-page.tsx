import { type ComponentProps, type ReactElement, type ReactNode } from "react";
import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@executor-js/ui/components/button";
import { cn } from "@executor-js/ui/lib/utils";
import { SessionMenu } from "./auth.tsx";
import { useProductBrand } from "@executor-js/ui/hooks/product-brand";
import { productWordmark } from "@executor-js/ui/contracts/product-brand";

export function SetupPage({
  className,
  children,
  organization,
  onSignOut,
}: ComponentProps<"main"> & {
  readonly organization?: string;
  readonly onSignOut?: () => void;
}) {
  const brand = useProductBrand();
  return (
    <main
      className={cn(
        "flex min-h-dvh flex-col items-center px-6 pt-6 pb-[calc(84px+env(safe-area-inset-bottom))] sm:pt-14 sm:pb-6",
        className,
      )}
    >
      <div className="mb-6 w-[200px] max-w-full self-end bg-background lg:fixed lg:bottom-[max(12px,_env(safe-area-inset-bottom))] lg:left-[max(12px,_env(safe-area-inset-left))] lg:z-10 lg:mb-0 lg:max-w-[calc(100%-88px)]">
        <SessionMenu organization={organization} onSignOut={onSignOut} />
      </div>
      <div className="flex min-h-0 w-full max-w-[600px] flex-1 flex-col">
        <div className="mb-8 flex items-center gap-2 font-mono text-[15px] max-sm:mb-6">
          <img src={brand.logo} alt="" width={20} height={20} className="size-5" />
          <span>{productWordmark(brand)}</span>
        </div>
        {children}
      </div>
    </main>
  );
}

export function SetupTitle({ className, ...props }: ComponentProps<"h1">) {
  return (
    <h1
      tabIndex={-1}
      className={cn(
        "text-3xl font-medium tracking-[-0.04em] outline-none max-sm:text-[26px]",
        className,
      )}
      {...props}
    />
  );
}

export function SetupLede({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("mt-3 text-sm leading-6 text-muted-foreground", className)} {...props} />;
}

export function SetupCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mt-6 overflow-clip rounded-xl border bg-card max-sm:-mx-6 max-sm:rounded-none max-sm:border-x-0",
        className,
      )}
      {...props}
    />
  );
}

export function SetupActions({ children }: { readonly children: ReactNode }) {
  return (
    <div className="z-20 shrink-0 bg-background max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:border-t max-sm:pb-[env(safe-area-inset-bottom)] sm:sticky sm:bottom-0 sm:mt-3">
      <div className="flex w-full items-center justify-end gap-3 py-3 max-sm:flex-wrap max-sm:gap-x-2 max-sm:gap-y-1.5 max-sm:px-6">
        {children}
      </div>
    </div>
  );
}

export function SetupNext({
  done,
  label,
  required = false,
  hint,
  children,
}: {
  readonly done: boolean;
  readonly label: string;
  readonly required?: boolean;
  readonly hint: string;
  readonly children: (content: ReactNode) => ReactElement;
}) {
  const content = (
    <span className="grid">
      <ForwardLabel shown={!done}>{required ? hint : "Skip for now"}</ForwardLabel>
      <ForwardLabel shown={done}>{label}</ForwardLabel>
    </span>
  );
  const forward = "ml-auto transition-[color,background-color,box-shadow,opacity] max-sm:flex-1";
  if (!required)
    return (
      <Button variant={done ? "default" : "secondary"} className={forward} asChild>
        {children(content)}
      </Button>
    );
  return done ? (
    <Button className={forward} asChild>
      {children(content)}
    </Button>
  ) : (
    <Button className={forward} disabled>
      {content}
    </Button>
  );
}

function ForwardLabel({ shown, children }: { readonly shown: boolean; readonly children: string }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center gap-2 [grid-area:1/1]",
        !shown && "invisible",
      )}
    >
      {children}
      <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} aria-hidden />
    </span>
  );
}

export function SetupBack({ children }: { readonly children: ReactNode }) {
  return (
    <Button variant="outline" className="max-sm:w-9 max-sm:px-0" asChild>
      {children}
    </Button>
  );
}
