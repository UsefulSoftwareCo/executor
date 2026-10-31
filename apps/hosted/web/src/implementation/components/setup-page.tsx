import { type ComponentProps, type ReactElement, type ReactNode } from "react";
import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@executor-js/ui/components/button";
import { cn } from "@executor-js/ui/lib/utils";
import { SessionMenu } from "./auth.tsx";
import { useProductBrand } from "@executor-js/ui/hooks/product-brand";
import { productWordmark } from "@executor-js/ui/contracts/product-brand";

/**
 * Onboarding pages are one 600px column under the Executor mark, with their actions right below
 * the step. Identity controls stay outside the instructions: wide screens pin them to the bottom
 * corner; narrower ones place them above the column. The column starts at a fixed top, so a step
 * that grows or shrinks never moves what is above it. A step that keeps its own content scrolling,
 * such as a list, passes `h-dvh` so the column ends at the bottom of the screen.
 */
export function SetupPage({
  className,
  children,
  organization,
  onSignOut,
}: ComponentProps<"main"> & {
  /** The team whose setup this is, so account settings know the way back to it. */
  readonly organization?: string;
  /** Reports leaving from a setup step, before the session ends. */
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

/** The step's heading. Screens that replace one another focus it through `ref`. */
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

/** One short line under the heading. */
export function SetupLede({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("mt-3 text-sm leading-6 text-muted-foreground", className)} {...props} />;
}

/**
 * The step's list or instructions. On phones it runs edge to edge; rows inside it use `px-4
 * max-sm:px-6` so their content lines up with the heading.
 */
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

/**
 * The step's actions. Wider screens place them right under the step, in the column, and keep them
 * on screen while a long step scrolls. Phones pin them to the bottom edge, full width.
 */
export function SetupActions({ children }: { readonly children: ReactNode }) {
  return (
    <div className="z-20 shrink-0 bg-background max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:border-t max-sm:pb-[env(safe-area-inset-bottom)] sm:sticky sm:bottom-0 sm:mt-3">
      <div className="flex w-full items-center justify-end gap-3 py-3 max-sm:flex-wrap max-sm:gap-x-2 max-sm:gap-y-1.5 max-sm:px-6">
        {children}
      </div>
    </div>
  );
}

/**
 * The step's one way forward, last on the row and full width on phones. Until the step's action is
 * done it is a quiet "Skip for now"; once `done`, the primary action named by `label`. Both labels
 * hold the button's box, so it keeps its size and place when it changes. `children` renders the
 * link or button for the current state around the content it is given.
 *
 * A `required` step cannot be skipped: until it is done the button is disabled and reads `hint`,
 * saying what to do, in place of "Skip for now".
 */
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
  // Hidden labels keep their width and leave the accessible name to the one shown.
  const content = (
    <span className="grid">
      <ForwardLabel shown={!done}>{required ? hint : "Skip for now"}</ForwardLabel>
      <ForwardLabel shown={done}>{label}</ForwardLabel>
    </span>
  );
  // Only its colors fade; its size follows the screen at once, so a resize never animates it.
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

/** One of the forward button's labels, with its arrow; a hidden one only holds its width. */
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

/**
 * Returns to the screen this one was chosen from, first on the row; `children` is its link. Phones
 * show only its icon, so the forward action keeps most of the row.
 */
export function SetupBack({ children }: { readonly children: ReactNode }) {
  return (
    <Button variant="outline" className="max-sm:w-9 max-sm:px-0" asChild>
      {children}
    </Button>
  );
}
