import { useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { Button } from "@executor-js/react/components/button";
import { Checkbox } from "@executor-js/react/components/checkbox";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/react/components/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@executor-js/react/components/dialog";
import {
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
} from "@executor-js/react/components/card-stack";

import {
  onepasswordConfigAtom,
  onepasswordVaultsAtom,
  configureOnePassword,
  removeOnePasswordConfig,
  onepasswordWriteKeys,
} from "./atoms";
import type { RedactedOnePasswordConfig, Vault } from "../sdk/types";

// ---------------------------------------------------------------------------
// Vault picker — multi-select
// ---------------------------------------------------------------------------

const VAULT_LIST_ERROR_FALLBACK = "Failed to list vaults";

const formatVaultListError = (error: Error): string => {
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OnePasswordError carries a typed `message`
  const message = error.message.trim();
  return message ? `${VAULT_LIST_ERROR_FALLBACK}: ${message}` : VAULT_LIST_ERROR_FALLBACK;
};

function VaultPicker(props: {
  authKind: "desktop-app" | "service-account";
  accountName: string;
  selected: ReadonlyArray<Vault>;
  onSelectedChange: (vaults: ReadonlyArray<Vault>) => void;
}) {
  const account = props.accountName.trim();
  const vaultsResult = useAtomValue(onepasswordVaultsAtom(props.authKind, account));

  const { vaults, isLoading, error } = AsyncResult.matchWithError(
    vaultsResult as AsyncResult.AsyncResult<
      { vaults: ReadonlyArray<{ id: string; name: string }> },
      Error
    >,
    {
      onInitial: () => ({
        vaults: [] as { id: string; name: string }[],
        isLoading: true,
        error: null,
      }),
      onError: (queryError) => ({
        vaults: [] as { id: string; name: string }[],
        isLoading: false,
        error: formatVaultListError(queryError),
      }),
      onDefect: () => ({
        vaults: [] as { id: string; name: string }[],
        isLoading: false,
        error: VAULT_LIST_ERROR_FALLBACK,
      }),
      onSuccess: ({ value }) => {
        const v = value.vaults;
        const onlyVault = v.length === 1 ? v[0] : undefined;
        if (onlyVault && props.selected.length === 0) {
          queueMicrotask(() => props.onSelectedChange([onlyVault]));
        }
        return { vaults: [...v], isLoading: false, error: null };
      },
    },
  );

  if (!account) {
    return (
      <p className="text-[11px] text-muted-foreground/50 py-1">
        Enter account details to load vaults.
      </p>
    );
  }

  // Selected vaults missing from the loaded list (renamed, revoked, or the
  // list failed to load while editing) stay visible so they can be unchecked.
  const loadedIds = new Set(vaults.map((v) => v.id));
  const stale = props.selected.filter((v) => !loadedIds.has(v.id));
  const rows = [...vaults, ...stale];

  const toggle = (vault: Vault, checked: boolean) => {
    if (checked) {
      if (!props.selected.some((v) => v.id === vault.id)) {
        props.onSelectedChange([...props.selected, vault]);
      }
      return;
    }
    props.onSelectedChange(props.selected.filter((v) => v.id !== vault.id));
  };

  return (
    <div className="grid gap-2">
      {isLoading ? (
        <p className="text-[11px] text-muted-foreground/50 py-1">Loading vaults…</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/50 py-1">No vaults found.</p>
      ) : (
        <div className="grid max-h-44 gap-0.5 overflow-y-auto rounded-md border border-input p-1">
          {rows.map((vault) => {
            const checked = props.selected.some((v) => v.id === vault.id);
            return (
              <Label
                key={vault.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 font-normal hover:bg-muted/40"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(value) => toggle(vault, value === true)}
                />
                <span className="truncate text-[13px] text-foreground">{vault.name}</span>
                {!loadedIds.has(vault.id) && (
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/50">
                    not found
                  </span>
                )}
              </Label>
            );
          })}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-1.5">
          <p className="text-[11px] text-destructive leading-relaxed whitespace-pre-line">
            {error}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config dialog
// ---------------------------------------------------------------------------

function ConfigDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial?: {
    authKind: string;
    accountName: string;
    vaults: ReadonlyArray<Vault>;
    name: string;
  };
}) {
  const isEdit = !!props.initial;
  const [authKind, setAuthKind] = useState<"desktop-app" | "service-account">(
    (props.initial?.authKind as "desktop-app" | "service-account") ?? "desktop-app",
  );
  const [accountName, setAccountName] = useState(props.initial?.accountName ?? "my.1password.com");
  const [selectedVaults, setSelectedVaults] = useState<ReadonlyArray<Vault>>(
    props.initial?.vaults ?? [],
  );
  const [displayName, setDisplayName] = useState(props.initial?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doConfigure = useAtomSet(configureOnePassword, { mode: "promiseExit" });

  const reset = () => {
    if (!isEdit) {
      setAuthKind("desktop-app");
      setAccountName("my.1password.com");
      setSelectedVaults([]);
      setDisplayName("");
    }
    setError(null);
    setSaving(false);
  };

  const handleSave = async () => {
    const [firstVault, ...restVaults] = selectedVaults;
    if (!accountName.trim() || firstVault === undefined) return;
    setSaving(true);
    setError(null);

    const auth =
      authKind === "desktop-app"
        ? { kind: "desktop-app" as const, accountName: accountName.trim() }
        : { kind: "service-account" as const, token: accountName.trim() };

    const exit = await doConfigure({
      payload: {
        auth,
        vaults: [firstVault, ...restVaults],
        name: displayName.trim() || "1Password",
      },
      reactivityKeys: onepasswordWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError("Failed to save configuration");
      setSaving(false);
      return;
    }

    props.onOpenChange(false);
    reset();
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(v) => {
        if (!v) reset();
        props.onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">
            {isEdit ? "Edit 1Password" : "Connect 1Password"}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            Link one or more vaults to resolve secrets via the 1Password desktop app or a service
            account.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-3">
          {/* Auth method */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Auth method
            </Label>
            <Select
              value={authKind}
              onValueChange={(v) => setAuthKind(v as "desktop-app" | "service-account")}
            >
              <SelectTrigger className="h-9 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desktop-app">Desktop App (biometric)</SelectItem>
                <SelectItem value="service-account">Service Account</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Account / token */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {authKind === "desktop-app" ? "Account domain" : "Service account token"}
            </Label>
            <Input
              placeholder={authKind === "desktop-app" ? "my.1password.com" : "ops_..."}
              value={accountName}
              onChange={(e) => setAccountName((e.target as HTMLInputElement).value)}
              className="font-mono text-[13px] h-9"
            />
            <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
              {authKind === "desktop-app"
                ? "Requires the 1Password desktop app with biometric unlock."
                : "The token is stored in this provider's owner-scoped config and never surfaced again."}
            </p>
          </div>

          {/* Vaults */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Vaults
            </Label>
            <VaultPicker
              authKind={authKind}
              accountName={accountName}
              selected={selectedVaults}
              onSelectedChange={setSelectedVaults}
            />
          </div>

          {/* Display name */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Display name
            </Label>
            <Input
              placeholder="1Password"
              value={displayName}
              onChange={(e) => setDisplayName((e.target as HTMLInputElement).value)}
              className="text-[13px] h-9"
            />
          </div>

          {error && (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive whitespace-pre-line">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!accountName.trim() || selectedVaults.length === 0 || saving}
          >
            {saving ? "Saving…" : isEdit ? "Update" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Settings card
// ---------------------------------------------------------------------------

export default function OnePasswordSettings() {
  const [configOpen, setConfigOpen] = useState(false);
  const configResult = useAtomValue(onepasswordConfigAtom);
  const doRemove = useAtomSet(removeOnePasswordConfig, { mode: "promiseExit" });

  const handleRemove = async () => {
    await doRemove({ reactivityKeys: onepasswordWriteKeys });
  };

  const config: RedactedOnePasswordConfig | null = AsyncResult.match(
    configResult as AsyncResult.AsyncResult<RedactedOnePasswordConfig | null, unknown>,
    {
      onInitial: () => null,
      onFailure: () => null,
      onSuccess: ({ value }) => value,
    },
  );
  const isLoading = AsyncResult.match(
    configResult as AsyncResult.AsyncResult<RedactedOnePasswordConfig | null, unknown>,
    {
      onInitial: () => true,
      onFailure: () => false,
      onSuccess: () => false,
    },
  );
  const isError = AsyncResult.match(
    configResult as AsyncResult.AsyncResult<RedactedOnePasswordConfig | null, unknown>,
    {
      onInitial: () => false,
      onFailure: () => true,
      onSuccess: () => false,
    },
  );

  return (
    <>
      <CardStackEntry>
        <CardStackEntryContent>
          {isLoading ? (
            <CardStackEntryDescription>Loading…</CardStackEntryDescription>
          ) : isError ? (
            <CardStackEntryDescription className="text-destructive">
              Failed to load configuration
            </CardStackEntryDescription>
          ) : config ? (
            <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[12px]">
              <span className="text-muted-foreground/60">Auth</span>
              <span className="font-mono text-foreground/80 truncate">
                {config.auth.kind === "desktop-app" ? config.auth.accountName : "service-account"}
              </span>
              <span className="text-muted-foreground/60">
                {config.vaults.length === 1 ? "Vault" : "Vaults"}
              </span>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-foreground/80 truncate">
                  {config.vaults.map((vault) => vault.name).join(", ")}
                </span>
              </div>
            </div>
          ) : (
            <CardStackEntryDescription>
              Resolve secrets from your 1Password vaults.
            </CardStackEntryDescription>
          )}
        </CardStackEntryContent>
        <CardStackEntryActions>
          {config ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-[12px]"
                onClick={() => setConfigOpen(true)}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-[12px] text-destructive/70 hover:text-destructive"
                onClick={handleRemove}
              >
                Disconnect
              </Button>
            </>
          ) : (
            !isLoading &&
            !isError && (
              <Button
                variant="link"
                size="sm"
                className="h-7 px-0 text-[12px] shrink-0"
                onClick={() => setConfigOpen(true)}
              >
                Add 1Password
              </Button>
            )
          )}
        </CardStackEntryActions>
      </CardStackEntry>

      {configOpen && (
        <ConfigDialog
          open={configOpen}
          onOpenChange={setConfigOpen}
          initial={
            config
              ? {
                  authKind: config.auth.kind,
                  // Service-account tokens are never surfaced (redacted); the
                  // user re-enters the token when editing that auth method.
                  accountName: config.auth.kind === "desktop-app" ? config.auth.accountName : "",
                  vaults: config.vaults,
                  name: config.name,
                }
              : undefined
          }
        />
      )}
    </>
  );
}
