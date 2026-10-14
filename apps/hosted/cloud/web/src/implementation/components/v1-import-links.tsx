import { useAtomValue } from "@effect/atom-react";
import { useState, type ReactNode } from "react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Button } from "@executor-js/ui/components/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  DatabaseImportIcon,
} from "@hugeicons/core-free-icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@executor-js/ui/components/dialog";
import { useOrganizationRoute } from "@executor-js/hosted-web/organization";
import { v1ImportChoicesAtom } from "../../contracts/v1-import.ts";
import { V1ImportContent, v1ImportDescription, v1ImportTitle } from "./v1-import.tsx";

/** The caller's v1 workspaces, once the browser-only query has loaded. Unreachable reads as none. */
function useV1ImportChoices() {
  return Option.getOrUndefined(AsyncResult.value(useAtomValue(v1ImportChoicesAtom)));
}

type Choices = NonNullable<ReturnType<typeof useV1ImportChoices>>;

/**
 * Whether there is a v1 workspace to import now: eligible and not yet imported. A member of a
 * shared workspace cannot import it, so they are not offered an import that would only refuse them.
 */
const canImport = (choices: Choices | undefined) =>
  choices !== undefined &&
  choices.organizations.some(
    (organization) => organization.eligible && organization.target === null,
  );

export function useCanImportFromV1() {
  return canImport(useV1ImportChoices());
}

/**
 * The import over the current organization's page, importing into it by default. Callers keep
 * it mounted while it is open: finishing refreshes the choices, which can hide its trigger.
 */
function V1ImportDialog({
  trigger,
  open,
  onOpenChange,
}: {
  readonly trigger: ReactNode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const organization = useOrganizationRoute();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[88dvh] gap-0 overflow-y-auto p-8 sm:max-w-[760px]">
        <DialogTitle className="text-xl font-medium tracking-[-0.03em]">
          {v1ImportTitle}
        </DialogTitle>
        <DialogDescription className="mt-2 mb-6 leading-relaxed">
          {v1ImportDescription}
        </DialogDescription>
        {open && <V1ImportContent into={organization.id} />}
      </DialogContent>
    </Dialog>
  );
}

const dismissedKey = "executor:v1-import:notice-dismissed";

/**
 * Whether this browser dismissed the sidebar card. Only the card is skipped: Settings still offers
 * the import. The card renders only after the browser-only choices load, so storage is readable.
 */
function useNoticeDismissed() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(dismissedKey) === "yes");
  const dismiss = () => {
    localStorage.setItem(dismissedKey, "yes");
    setDismissed(true);
  };
  return [dismissed, dismiss] as const;
}

/**
 * The sidebar's v1 item. Once a workspace is imported it is a way back to that workspace's v1
 * dashboard; before that, a card that points people with a v1 workspace at the import, until
 * they skip it.
 */
export function V1ImportNotice() {
  const choices = useV1ImportChoices();
  if (choices === undefined) return null;
  return <LoadedNotice choices={choices} />;
}

function LoadedNotice({ choices }: { readonly choices: Choices }) {
  const organization = useOrganizationRoute();
  const [dismissed, dismiss] = useNoticeDismissed();
  const [importing, setImporting] = useState(false);
  const imported = choices.organizations.flatMap((choice) =>
    choice.target !== null && choice.v1Url !== null
      ? [{ into: choice.target.id, v1Url: choice.v1Url }]
      : [],
  );
  const back = imported.find((choice) => choice.into === organization.id) ?? imported[0];
  if (importing || (back === undefined && canImport(choices) && !dismissed))
    return <ImportCard open={importing} onOpenChange={setImporting} dismiss={dismiss} />;
  return back === undefined ? null : <BackToV1 href={back.v1Url} />;
}

/** A way back, not a call to action, so it is quieter than the import card. */
function BackToV1({ href }: { readonly href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} size={14} aria-hidden />
      <span className="min-w-0 flex-1 truncate">Back to v1</span>
      <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} size={12} aria-hidden />
    </a>
  );
}

function ImportCard({
  open,
  onOpenChange,
  dismiss,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly dismiss: () => void;
}) {
  return (
    <div className="relative">
      <V1ImportDialog
        open={open}
        onOpenChange={onOpenChange}
        trigger={
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-lg border bg-card p-2.5 pr-9 text-left text-foreground hover:bg-accent"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
              <HugeiconsIcon icon={DatabaseImportIcon} strokeWidth={2} size={15} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-medium leading-tight">Import your data</span>
              <span className="block text-[11px] leading-tight text-muted-foreground">
                From Executor v1
              </span>
            </span>
          </button>
        }
      />
      <button
        type="button"
        aria-label="Skip the v1 import"
        title="Skip. You can still import from Settings."
        onClick={dismiss}
        className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} size={13} aria-hidden />
      </button>
    </div>
  );
}

/**
 * People who already have a v2 organization reach the import here, for workspaces not yet
 * imported; others never see it.
 */
export function V1ImportSettings() {
  const [importing, setImporting] = useState(false);
  if (!useCanImportFromV1() && !importing) return null;
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="gap-1.5 px-4 pt-4 pb-3">
        <CardTitle>
          <h2>Import from Executor v1</h2>
        </CardTitle>
        <CardDescription>
          Bring a v1 workspace's integrations, connections, policies, toolkits and artifacts into
          Executor v2.
        </CardDescription>
      </CardHeader>
      <CardFooter className="px-4 pb-4">
        <V1ImportDialog
          open={importing}
          onOpenChange={setImporting}
          trigger={<Button variant="outline">Import your data</Button>}
        />
      </CardFooter>
    </Card>
  );
}
