/** Saved identities reuse one actual grant; the host remains authoritative for every selected app. */
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Exit, type Cause } from "effect";
import type {
  Account,
  AccountId,
  AppId,
  OAuthConnectionPlan,
  OAuthStartResult,
  Provider,
} from "@executor-js/sdk";
import type { FailureProps, Inventory, Query } from "../../contracts/dashboard.ts";
import { accountGroups } from "../../contracts/account-identities.ts";
import {
  identityAppTargets,
  identityMethod,
  type IdentityConsentBindings,
  type IdentityConsentSelection,
} from "../../contracts/identity-consent.ts";
import { QueryView } from "./context.tsx";
import { Button } from "../components/button.tsx";
import { Checkbox } from "../components/checkbox.tsx";
import { Label } from "../components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";

interface Props<E, S extends OAuthStartResult> extends IdentityConsentBindings<E> {
  readonly query: Query<Inventory, E>;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly provider: Provider;
  readonly method: string;
  readonly app: AppId;
  readonly initialAccount?: AccountId | undefined;
  readonly disabled: boolean;
  readonly onPendingChange: (pending: boolean) => void;
  readonly start: (selection: IdentityConsentSelection) => Promise<Exit.Exit<S, E>>;
  readonly onAuthorized: (value: S) => void;
  readonly onSaved: (account: Account) => void;
  readonly children: (selection: IdentityConsentSelection) => ReactNode;
}

export function IdentityConsent<E, S extends OAuthStartResult>(props: Props<E, S>) {
  const identity = identityMethod(props.provider, props.method);
  if (identity === undefined) return props.children({});
  return (
    <QueryView
      query={props.query}
      Failure={props.Failure}
      pending={<p className="text-sm text-muted-foreground">Loading saved accounts…</p>}
    >
      {(inventory) => (
        <IdentityConsentFields
          {...props}
          inventory={inventory}
          issuer={identity.issuer}
          family={identity.name}
        />
      )}
    </QueryView>
  );
}

function IdentityConsentFields<E, S extends OAuthStartResult>({
  inventory,
  issuer,
  family,
  ...props
}: Props<E, S> & {
  readonly inventory: Inventory;
  readonly issuer: string;
  readonly family: string;
}) {
  const groups = useMemo(
    () =>
      accountGroups(inventory.accounts.filter((account) => account.identity?.issuer === issuer)),
    [inventory.accounts, issuer],
  );
  const initial =
    groups.find((group) => group.bindings.some((binding) => binding.id === props.initialAccount)) ??
    (groups.length === 1 ? groups[0] : undefined);
  const [choice, setChoice] = useState<string>(initial?.account.identity?.id ?? "new");
  const [selectedApps, setSelectedApps] = useState<readonly string[]>([]);
  const targets = useMemo(
    () => identityAppTargets(inventory, issuer, props.app),
    [inventory, issuer, props.app],
  );
  const group = groups.find((entry) => entry.account.identity?.id === choice);
  const additionalTargets = useMemo(
    () =>
      targets
        .filter((target) => selectedApps.includes(`${target.app.id}:${target.requirement}`))
        .map((target) => ({
          app: target.app.id,
          requirement: target.requirement,
          scope: target.target.scope,
          method: target.method,
        })),
    [targets, selectedApps],
  );
  const [planningResult, setPlanningResult] = useState<{
    readonly group: typeof group;
    readonly method: string;
    readonly targets: typeof additionalTargets;
    readonly value: { readonly source: AccountId; readonly plan: OAuthConnectionPlan } | undefined;
  }>();
  const matchingResult =
    planningResult?.group === group &&
    planningResult?.method === props.method &&
    planningResult?.targets === additionalTargets;
  const planned = matchingResult ? planningResult?.value : undefined;
  const planning = group !== undefined && !matchingResult;
  const setPlanned = (value: typeof planned) =>
    setPlanningResult({ group, method: props.method, targets: additionalTargets, value });
  const [error, setError] = useState<Cause.Cause<E>>();
  const [pending, setPending] = useState(false);
  const { plan, method } = props;
  useEffect(() => {
    let current = true;
    if (group === undefined) return;
    // An Atom command has one result; overlapping writes would cancel or misassociate plans.
    void (async () => {
      const ready: { source: AccountId; plan: OAuthConnectionPlan }[] = [];
      let failure: Cause.Cause<E> | undefined;
      for (const account of group.bindings) {
        const result = await plan({ method, sourceAccount: account.id, additionalTargets });
        if (!current) return;
        if (Exit.isSuccess(result)) {
          ready.push({ source: account.id, plan: result.value });
          if (result.value.status === "reuse") break;
        } else failure = result.cause;
      }
      ready.sort(
        (a, b) =>
          Number(a.plan.status === "incompatible") - Number(b.plan.status === "incompatible") ||
          a.plan.missingScopes.length - b.plan.missingScopes.length,
      );
      setPlanningResult({ group, method, targets: additionalTargets, value: ready[0] });
      if (ready.length === 0) setError(failure);
    })();
    return () => {
      current = false;
    };
  }, [group, method, plan, additionalTargets]);
  const selection = {
    sourceAccount: group === undefined ? null : (planned?.source ?? group.account.id),
    additionalTargets,
  };
  const busy = props.disabled || pending;
  const choose = (value: string) => {
    setChoice(value);
    setError(undefined);
  };
  return (
    <div className="space-y-4">
      {groups.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor="saved-identity">{family} account</Label>
          <Select value={choice} onValueChange={choose} disabled={busy}>
            <SelectTrigger id="saved-identity" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {groups.map(({ account }) => (
                <SelectItem key={account.identity?.id} value={account.identity!.id}>
                  {account.identity?.label}
                </SelectItem>
              ))}
              <SelectItem value="new">Use another {family} account</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {targets.length > 0 && (
        <fieldset disabled={busy} className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Connect more apps in this sign-in</legend>
          {targets.map((target) => {
            const key = `${target.app.id}:${target.requirement}`;
            const linked = inventory.links.some(
              (link) =>
                link.app === target.app.id &&
                group?.bindings.some((binding) => binding.id === link.account),
            );
            return (
              <label key={key} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selectedApps.includes(key)}
                  disabled={linked}
                  onCheckedChange={(checked) => {
                    setError(undefined);
                    setSelectedApps((current) =>
                      checked === true
                        ? [...current, key]
                        : current.filter((value) => value !== key),
                    );
                  }}
                />
                {target.app.name}
                {linked && <span className="text-xs text-muted-foreground">Already connected</span>}
              </label>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Read and write access required by the selected apps.
          </p>
        </fieldset>
      )}
      {error !== undefined && <props.Failure cause={error} layout="compact" />}
      {group === undefined ? (
        props.children(selection)
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {planning
              ? "Checking this account’s permissions…"
              : planned?.plan.status === "reuse"
                ? "This account already has the access these apps need."
                : planned?.plan.status === "incompatible"
                  ? "This sign-in cannot be shared with the selected apps. Choose another account or connect the apps separately."
                  : "Continue to approve the additional access. Your connected apps keep working."}
          </p>
          <Button
            disabled={
              busy || planning || planned === undefined || planned.plan.status === "incompatible"
            }
            loading={pending || planning}
            onClick={async () => {
              if (planned === undefined) return;
              setPending(true);
              props.onPendingChange(true);
              setError(undefined);
              const selected = { sourceAccount: planned.source, additionalTargets };
              if (planned.plan.status === "reuse") {
                const result = await props.reuse({ method, ...selected });
                if (Exit.isFailure(result)) setError(result.cause);
                else if (result.value.status === "completed") props.onSaved(result.value.account);
                else
                  setPlanned({
                    source: planned.source,
                    plan: {
                      ...planned.plan,
                      status: "consent-required",
                      reason: result.value.reason,
                    },
                  });
              } else {
                const result = await props.start(selected);
                if (Exit.isFailure(result)) setError(result.cause);
                else props.onAuthorized(result.value);
              }
              setPending(false);
              props.onPendingChange(false);
            }}
          >
            {planned?.plan.status === "reuse"
              ? additionalTargets.length > 0
                ? "Add apps"
                : "Add app"
              : `Continue with ${family}`}
          </Button>
        </div>
      )}
    </div>
  );
}
