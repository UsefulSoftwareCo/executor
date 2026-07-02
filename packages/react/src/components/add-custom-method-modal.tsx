import { useState } from "react";

import { emptyPlacement, type AuthMethod, type Placement } from "../lib/auth-placements";
import { Button } from "./button";
import { DialogFooter } from "./dialog";
import { Input } from "./input";
import { Label } from "./label";
import { PlacementEditor } from "./placement-editor";

// ---------------------------------------------------------------------------
// Add custom auth method — apiKey-only, plugin-agnostic.
//
// A custom method is reusable: any account on this integration can pick it. The
// user names it and declares one or more PLACEMENTS (where the credential goes).
// This component owns the UI; the plugin-specific persistence (mapping generic
// placements to its wire template + the configure mutation) is INJECTED via
// `onCreate`, so `packages/react` never imports a plugin package (the dependency
// runs the other way). OAuth is never offered here — custom methods are
// apiKey-only (decided).
// ---------------------------------------------------------------------------

/** Persist a custom method built from the user's placements. Returns the
 *  created `AuthMethod` (so the caller can select it) or `null` on failure. The
 *  plugin binds this to its own template converter + configure mutation. */
export type CreateCustomMethod = (input: {
  readonly label: string;
  readonly placements: readonly Placement[];
}) => Promise<AuthMethod | null>;

export function AddCustomMethodForm(props: {
  readonly onCreate: CreateCustomMethod;
  readonly onCreated: (method: AuthMethod) => void;
  readonly onCancel: () => void;
}) {
  const { onCreate, onCreated, onCancel } = props;

  const [label, setLabel] = useState("");
  const [placements, setPlacements] = useState<Placement[]>([emptyPlacement()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const namedPlacements = placements.filter((p: Placement) => p.name.trim().length > 0);
  const canSubmit = !submitting && namedPlacements.length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const created = await onCreate({
      label: label.trim(),
      placements: namedPlacements,
    });
    if (created === null) {
      setSubmitting(false);
      setError("Failed to add method. Please try again.");
      return;
    }
    onCreated(created);
  };

  return (
    <>
      <div className="space-y-5 px-5 py-5">
        <div className="rounded-md border border-border/70 bg-muted/20 p-3.5">
          <div className="grid gap-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center">
            <div>
              <Label htmlFor="custom-method-name" className="text-sm font-medium">
                Method name
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Optional; shown in the connection picker.
              </p>
            </div>
            <Input
              id="custom-method-name"
              className="h-9"
              placeholder="API key"
              value={label}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <div>
            <Label className="text-sm font-medium">Credential placement</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Bearer-token APIs usually use an Authorization header with a Bearer prefix.
            </p>
          </div>
          <PlacementEditor placements={placements} onChange={setPlacements} />
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>

      <DialogFooter className="border-t border-border/60 bg-muted/20 px-5 py-4">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {submitting ? "Adding…" : "Add method"}
        </Button>
      </DialogFooter>
    </>
  );
}
