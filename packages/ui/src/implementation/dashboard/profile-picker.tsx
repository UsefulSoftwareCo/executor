import { useState, type ComponentType, type ReactNode } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import type { Profile, ProfileInputs } from "@executor-js/sdk";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { FailureProps } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../components/dropdown-menu.tsx";
import type { AccountContext } from "./account-group.tsx";

type SelectionProps = {
  readonly contexts: readonly AccountContext[];
  readonly selected: AccountContext | undefined;
  readonly onSelect: (context: AccountContext) => void;
};
type ManagementProps<E> = {
  readonly setEnabled: Atom.AtomResultFn<
    Omit<typeof ProfileInputs.setEnabled.Type, "app" | "profile">,
    Profile,
    E
  >;
  readonly remove: Atom.AtomResultFn<void, Profile, E>;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly onRemoved: () => void | Promise<void>;
};

/** Additional profiles reveal selection and management together in the app header. */
export function ProfilePicker<E>({
  management,
  ...selection
}: SelectionProps & {
  readonly management?: ManagementProps<E> | undefined;
}) {
  if (selection.contexts.length < 2) return null;
  return management && selection.selected?.profile ? (
    <ManagedPicker
      key={selection.selected.key}
      {...selection}
      {...management}
      profile={selection.selected.profile}
      label={selection.selected.label}
    />
  ) : (
    <PickerMenu {...selection} />
  );
}

/** Keep confirmation mounted after the dropdown closes, tied to the selected profile. */
function ManagedPicker<E>({
  profile,
  label,
  setEnabled,
  remove,
  Failure,
  onRemoved,
  ...selection
}: SelectionProps &
  ManagementProps<E> & {
    readonly profile: Profile;
    readonly label: string;
  }) {
  const [confirm, setConfirm] = useState(false);
  const enable = useAtomSet(setEnabled);
  const enabledResult = useAtomValue(setEnabled);
  const stop = useAtomSet(remove, { mode: "promiseExit" });
  const removed = useAtomValue(remove);
  const pending = AsyncResult.isWaiting(removed);
  return (
    <>
      <PickerMenu
        {...selection}
        actions={
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={profile.enabled}
              disabled={AsyncResult.isWaiting(enabledResult) || profile.status === "removing"}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(enabled) => enable({ enabled, expectedRevision: profile.revision })}
            >
              Enabled
            </DropdownMenuCheckboxItem>
            {AsyncResult.isFailure(enabledResult) && <Failure cause={enabledResult.cause} />}
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
              Remove profile…
            </DropdownMenuItem>
          </>
        }
      />
      <Dialog
        open={confirm}
        onOpenChange={(open) => {
          if (!pending) setConfirm(open);
        }}
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogTitle>Remove profile?</DialogTitle>
          <p className="text-sm font-medium">{label}</p>
          <DialogDescription>
            This stops this profile’s webhooks, workflows and schedules. Your saved accounts, other
            profiles and app data remain.
          </DialogDescription>
          {AsyncResult.isFailure(removed) && <Failure cause={removed.cause} />}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={pending}
              onClick={async () => {
                const result = await stop();
                if (Exit.isSuccess(result)) {
                  setConfirm(false);
                  await onRemoved();
                }
              }}
            >
              Remove profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PickerMenu({
  contexts,
  selected,
  onSelect,
  actions,
}: SelectionProps & { readonly actions?: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="max-w-64 justify-between gap-3 max-[740px]:max-w-48"
          aria-label="Choose profile"
        >
          <span className="truncate">{selected?.label ?? "Choose profile"}</span>
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} className="shrink-0" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)] w-80">
        <DropdownMenuRadioGroup
          value={selected?.key ?? ""}
          onValueChange={(key) => {
            const context = contexts.find((item) => item.key === key);
            if (context) onSelect(context);
          }}
        >
          {contexts.map((context) => (
            <DropdownMenuRadioItem
              key={context.key}
              value={context.key}
              className="items-start py-2"
            >
              <span className="min-w-0 break-words">
                {context.label}
                {context.profile?.enabled === false && (
                  <span className="block text-xs text-muted-foreground">Disabled</span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {actions}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
