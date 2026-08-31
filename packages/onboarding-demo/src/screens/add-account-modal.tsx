// Reproduction of packages/react/src/components/add-account-modal.tsx.
//
// The credential path is a 2-step wizard behind a horizontally scrolling strip
// of auth-method tabs. Step 1 is the key plus an optional read-only probe;
// step 2 is the display name and the "Connection saved to" owner picker. The
// OAuth path is not a wizard and shows an app picker instead.
//
// The word "Personal" is reproduced at every site it occurs on the real screen:
// the derived connection name, the callable-name hint, the owner picker's label
// and its selected option.

import { useState } from "react";
import { EyeIcon, EyeOffIcon, PlusIcon } from "lucide-react";
import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@executor-js/react/components/tabs";
import { NativeSelect, NativeSelectOption } from "@executor-js/react/components/native-select";
import { cn } from "@executor-js/react/lib/utils";
import type { DemoAuthMethod } from "../fixtures";

function StepHeader(props: { readonly label: string; readonly hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {props.label}
      </Label>
      {props.hint ? <span className="text-xs text-muted-foreground/70">{props.hint}</span> : null}
    </div>
  );
}

function PlacementLine(props: { readonly placement: DemoAuthMethod["placements"][number] }) {
  const { placement } = props;
  const lead =
    placement.carrier === "header"
      ? `${placement.name || "Authorization"}: `
      : placement.carrier === "env"
        ? `${placement.name || "TOKEN"}=`
        : `?${placement.name || "api_key"}=`;
  return (
    <span className="wrap-anywhere whitespace-pre-wrap font-mono text-xs text-muted-foreground">
      {lead}
      {placement.prefix ? (
        <span className="text-muted-foreground/60">{placement.prefix}</span>
      ) : null}
      <span className="tracking-widest text-primary">••••••</span>
    </span>
  );
}

export function AddAccountModal(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly integrationName: string;
  readonly methods: readonly DemoAuthMethod[];
  /** Start on the wizard's second step, which is the screen the owner picker
   *  and its repeated "Personal" live on. */
  readonly initialStep?: "validate" | "place";
  /** Reproduce the post-OAuth stuck state: the popup was closed, and the
   *  button never leaves "Connecting…". */
  readonly stuckConnecting?: boolean;
  readonly onAdded: () => void;
}) {
  const [methodId, setMethodId] = useState(props.methods[0]?.id ?? "");
  const [wizardStep, setWizardStep] = useState<"validate" | "place">(
    props.initialStep ?? "validate",
  );
  const [secret, setSecret] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState<"user" | "org">("user");

  const method = props.methods.find((candidate) => candidate.id === methodId) ?? props.methods[0];
  const isOAuth = method?.kind === "oauth";
  const wizardActive = !isOAuth;
  const showValidateStep = !wizardActive || wizardStep === "validate";
  const showPlaceStep = !wizardActive || wizardStep === "place";

  const ownerWord = owner === "user" ? "Personal" : "Workspace";
  const derivedName = `${ownerWord} ${props.integrationName}`;
  const callableName = (label.trim() || derivedName).toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const singlePlacement = method?.placements[0];
  const affix =
    singlePlacement && singlePlacement.carrier === "header"
      ? `${singlePlacement.name}: ${singlePlacement.prefix}`
      : null;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} modal={false}>
      <DialogContent forceOverlay className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Add connection · {props.integrationName}
            {wizardActive ? (
              <span className="ml-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Step {wizardStep === "validate" ? 1 : 2} of 2
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            A connection is a saved way to use this integration, owned by you or the workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="flex w-full min-w-0 flex-col gap-5">
          {showValidateStep && (
            <Tabs
              value={methodId}
              onValueChange={(next: string) => {
                setMethodId(next);
                setWizardStep("validate");
              }}
              className="w-full min-w-0 max-w-full gap-0"
            >
              <TabsList className="flex h-10 w-full min-w-0 max-w-full justify-start overflow-x-auto overflow-y-hidden rounded-b-none rounded-t-md border border-b-0 border-border/60 bg-muted/30 p-1 [scrollbar-width:thin]">
                <div className="flex w-max shrink-0 items-stretch gap-1">
                  {props.methods.map((candidate) => (
                    <div
                      key={candidate.id}
                      className="group/method-tab relative flex h-8 shrink-0 items-stretch"
                    >
                      <TabsTrigger
                        value={candidate.id}
                        className="h-full max-w-64 shrink-0 justify-start px-3 text-sm font-medium"
                      >
                        <span className="truncate">{candidate.label}</span>
                      </TabsTrigger>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Add authentication method"
                    className="h-8 shrink-0 rounded-md border border-transparent bg-transparent px-3 text-foreground/60 hover:bg-background/60"
                  >
                    <PlusIcon className="size-4" />
                  </Button>
                </div>
              </TabsList>

              <TabsContent
                value={methodId}
                className={cn(
                  "mt-0 min-w-0 space-y-5",
                  "rounded-b-md rounded-t-none border border-border/60 bg-muted/15 p-4",
                )}
              >
                {method && !isOAuth && method.placements.length > 0 && !affix ? (
                  <div className="flex flex-wrap gap-x-3.5 gap-y-1">
                    {method.placements.map((placement, index) => (
                      <PlacementLine key={index} placement={placement} />
                    ))}
                  </div>
                ) : null}

                <div className="space-y-2">
                  <StepHeader label={isOAuth ? "OAuth app" : "Credential"} />

                  {isOAuth ? (
                    <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-3">
                      <p className="text-sm font-medium">No app for {props.integrationName} yet</p>
                      <p className="text-xs text-muted-foreground">
                        None of your registered apps target this integration&apos;s OAuth endpoint.
                        Register one to connect.
                      </p>
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <Button type="button" size="sm">
                          Register app
                        </Button>
                      </div>
                    </div>
                  ) : affix ? (
                    <div className="flex h-9 w-full min-w-0 items-stretch overflow-hidden rounded-md border border-input bg-transparent font-mono text-sm shadow-xs transition-colors focus-within:border-ring dark:bg-input/30">
                      <span className="flex min-w-0 max-w-[60%] select-none items-center border-r border-input bg-muted/40 px-3 text-muted-foreground/70">
                        <span className="overflow-hidden text-ellipsis whitespace-pre">
                          {affix}
                        </span>
                      </span>
                      {/* oxlint-disable-next-line react/forbid-elements */}
                      <input
                        type={revealed ? "text" : "password"}
                        autoComplete="off"
                        aria-label="API key"
                        value={secret}
                        onChange={(event) => setSecret(event.target.value)}
                        className="min-w-0 flex-1 bg-transparent px-3 outline-none"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Show key"
                        aria-pressed={revealed}
                        className="shrink-0 text-muted-foreground"
                        onClick={() => setRevealed((value) => !value)}
                      >
                        {revealed ? <EyeOffIcon /> : <EyeIcon />}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <Input
                        type={revealed ? "text" : "password"}
                        aria-label="API key"
                        value={secret}
                        onChange={(event) => setSecret((event.target as HTMLInputElement).value)}
                        className="font-mono"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Show key"
                        aria-pressed={revealed}
                        className="shrink-0 text-muted-foreground"
                        onClick={() => setRevealed((value) => !value)}
                      >
                        {revealed ? <EyeOffIcon /> : <EyeIcon />}
                      </Button>
                    </div>
                  )}
                </div>

                {!isOAuth && (
                  <div className="space-y-1.5">
                    <StepHeader
                      label="Check the key works"
                      hint="runs one read-only call with your key, saved as this integration's health check"
                    />
                    <div className="space-y-2 rounded-md border border-border/60 bg-background px-3 py-3">
                      <Label className="text-xs text-muted-foreground">Operation</Label>
                      <NativeSelect size="sm" defaultValue="" aria-label="Health check operation">
                        <NativeSelectOption value="">Pick an operation…</NativeSelectOption>
                        <NativeSelectOption value="users_me">users_me</NativeSelectOption>
                        <NativeSelectOption value="organizations_list">
                          organizations_list
                        </NativeSelectOption>
                        <NativeSelectOption value="projects_list">projects_list</NativeSelectOption>
                      </NativeSelect>
                      <Button type="button" variant="outline" size="sm" disabled={!secret}>
                        Check
                      </Button>
                    </div>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          )}

          {showPlaceStep && (
            <>
              <div className="space-y-2">
                <StepHeader label="Display name" hint="how you'll tell accounts apart" />
                <Input
                  id="connection-name"
                  placeholder={derivedName}
                  value={label}
                  onChange={(event) => setLabel((event.target as HTMLInputElement).value)}
                />
                <p className="text-xs text-muted-foreground">
                  This connection will be callable as{" "}
                  <span className="font-mono text-foreground">{callableName}</span>.
                </p>
              </div>

              <div className="space-y-2">
                <StepHeader label="Connection saved to" />
                <NativeSelect
                  value={owner}
                  aria-label="Saved to"
                  onChange={(event) => setOwner(event.target.value === "org" ? "org" : "user")}
                >
                  <NativeSelectOption value="user">Personal</NativeSelectOption>
                  <NativeSelectOption value="org">Workspace</NativeSelectOption>
                </NativeSelect>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
            {isOAuth ? "Close" : "Cancel"}
          </Button>
          {isOAuth ? (
            <Button type="button" disabled>
              {props.stuckConnecting ? "Connecting…" : "Connect with OAuth"}
            </Button>
          ) : wizardStep === "validate" ? (
            <Button type="button" onClick={() => setWizardStep("place")}>
              Continue
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={() => setWizardStep("validate")}>
                Back
              </Button>
              <Button type="button" onClick={props.onAdded}>
                Add connection
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
