// ---------------------------------------------------------------------------
// Auth-method LIST editor — the add-flow's "How does this API authenticate?"
// section, as a list. Every plugin registers EVERY declared method (P6: add
// without auth, connect later), so the add flow edits a list of generic
// `AuthTemplateEditorValue` rows seeded from detection (spec analysis, endpoint
// probe, …) with add/remove and a per-row `AuthTemplateEditor`.
//
// Composition: `useAuthMethodList` is the headless row state (seeding,
// edit/add/remove); `AuthMethodListEditor` is the presentation. Plugins own
// only the codec at the edges — seeds in (detection → editor values) and
// submit out (editor values → wire templates).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { LockIcon, PlusIcon, XIcon } from "lucide-react";

import { PlacementLine } from "../lib/auth-placements";
import { Button } from "./button";
import { FieldLabel } from "./field";
import {
  AuthTemplateEditor,
  emptyApiKeyValue,
  type AuthTemplateEditorKind,
  type AuthTemplateEditorPreset,
  type AuthTemplateEditorValue,
} from "./auth-template-editor";

export interface AuthMethodSeed {
  readonly value: AuthTemplateEditorValue;
  /** The detected method's stable slug — an unedited seeded row submits with
   *  its EXACT original slug (preserving connections bound against it). */
  readonly slug?: string;
  /** Detection label (e.g. the spec's security-scheme name) shown on the row. */
  readonly label?: string;
}

export interface AuthMethodRow {
  readonly value: AuthTemplateEditorValue;
  /** True when this row came from detection (a seed), false when the user added
   *  it. Detected rows are immutable — the spec/probe declared them — so the
   *  editor renders them read-only. Not inferred from `seedSlug`: some plugins
   *  (MCP) seed a detected method with a label but no slug. */
  readonly seeded: boolean;
  readonly seedSlug?: string;
  readonly seedLabel?: string;
}

export interface AuthMethodListState {
  readonly rows: readonly AuthMethodRow[];
  readonly setRowAt: (index: number, next: AuthTemplateEditorValue) => void;
  readonly removeRowAt: (index: number) => void;
  readonly addRow: () => void;
}

/** Headless row state for the method list. Re-seeds whenever `seeds` changes
 *  identity (detection results are stable per analysis), discarding edits —
 *  fresh detection means a fresh starting set. */
export function useAuthMethodList(seeds: readonly AuthMethodSeed[]): AuthMethodListState {
  const [rows, setRows] = useState<readonly AuthMethodRow[]>([]);
  const seededFromRef = useRef<readonly AuthMethodSeed[] | null>(null);
  useEffect(() => {
    if (seededFromRef.current === seeds) return;
    seededFromRef.current = seeds;
    setRows(
      seeds.map(
        (seed: AuthMethodSeed): AuthMethodRow => ({
          value: seed.value,
          seeded: true,
          ...(seed.slug !== undefined ? { seedSlug: seed.slug } : {}),
          ...(seed.label !== undefined ? { seedLabel: seed.label } : {}),
        }),
      ),
    );
  }, [seeds]);

  const setRowAt = useCallback((index: number, next: AuthTemplateEditorValue) => {
    setRows((current: readonly AuthMethodRow[]) =>
      current.map((row: AuthMethodRow, i: number) => (i === index ? { ...row, value: next } : row)),
    );
  }, []);

  const removeRowAt = useCallback((index: number) => {
    setRows((current: readonly AuthMethodRow[]) =>
      current.filter((_row: AuthMethodRow, i: number) => i !== index),
    );
  }, []);

  const addRow = useCallback(() => {
    setRows((current: readonly AuthMethodRow[]) => [
      ...current,
      { value: emptyApiKeyValue(), seeded: false },
    ]);
  }, []);

  return { rows, setRowAt, removeRowAt, addRow };
}

export interface AuthMethodListEditorProps {
  readonly list: AuthMethodListState;
  readonly title?: string;
  /** Shown when the list is empty (e.g. "No authentication detected. …"). */
  readonly emptyHint?: string;
  /** Shown under the list when at least one row exists. */
  readonly footerHint?: string;
  /** Per-row editor restrictions — see `AuthTemplateEditorProps`. */
  readonly allowedKinds?: readonly AuthTemplateEditorKind[];
  readonly presets?: readonly AuthTemplateEditorPreset[];
  readonly oauthMetadata?: "editable" | "discovered";
}

export function AuthMethodListEditor(props: AuthMethodListEditorProps) {
  const { list, allowedKinds, presets, oauthMetadata } = props;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <FieldLabel>{props.title ?? "How does this API authenticate?"}</FieldLabel>
        <Button type="button" variant="outline" size="sm" onClick={list.addRow}>
          <PlusIcon />
          Add method
        </Button>
      </div>
      {list.rows.length === 0 ? (
        props.emptyHint ? (
          <p className="text-[11px] text-muted-foreground">{props.emptyHint}</p>
        ) : null
      ) : (
        <div className="flex flex-col gap-3">
          {list.rows.map((row: AuthMethodRow, index: number) => {
            // A row seeded from detection is the spec's own auth declaration:
            // it's IMMUTABLE here. We render it read-only (no kind selector, no
            // editable fields) so a user can't silently retype the spec's
            // method into something nothing backs (e.g. flipping a Bearer-token
            // API to OAuth with empty endpoints). The escape hatch is to remove
            // the row and add a custom one. Manually added rows (no seed) get
            // the full editor.
            const detected = row.seeded;
            return (
              <div
                key={index}
                className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    {detected ? <LockIcon className="size-3 shrink-0" aria-hidden /> : null}
                    <span>
                      Method {index + 1}
                      {row.seedLabel ? ` · ${row.seedLabel}` : ""}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove method"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => list.removeRowAt(index)}
                  >
                    <XIcon />
                  </Button>
                </div>
                {detected ? (
                  <DetectedMethodSummary value={row.value} oauthMetadata={oauthMetadata} />
                ) : (
                  <AuthTemplateEditor
                    value={row.value}
                    onChange={(next: AuthTemplateEditorValue) => list.setRowAt(index, next)}
                    {...(allowedKinds ? { allowedKinds } : {})}
                    {...(presets ? { presets } : {})}
                    {...(oauthMetadata ? { oauthMetadata } : {})}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {list.rows.length > 0 && props.footerHint ? (
        <p className="text-[11px] text-muted-foreground">{props.footerHint}</p>
      ) : null}
    </section>
  );
}

/** One read-only `label   value` line, mono value, for the detected summary. */
function SpecField(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{props.label}</span>
      <span className="break-all font-mono text-foreground/80">{props.value}</span>
    </div>
  );
}

/** Read-only view of a spec-detected method: shows what the spec declared
 *  (placements / OAuth endpoints) as a DISABLED, non-interactive block. The
 *  detected method is immutable here, so the summary is styled like a disabled
 *  field (muted, not-allowed cursor, text not selectable) to communicate that
 *  plainly. The only action is to remove the row (the header's X) and add a
 *  custom method to override. */
function DetectedMethodSummary(props: {
  readonly value: AuthTemplateEditorValue;
  readonly oauthMetadata?: "editable" | "discovered";
}) {
  const { value, oauthMetadata } = props;
  // Name the auth kind explicitly: a detection label like MCP's "Detected"
  // doesn't say whether it's OAuth or an API key, so surface it here.
  const kindLabel =
    value.kind === "oauth" ? "OAuth" : value.kind === "apikey" ? "API key" : "No auth";
  return (
    <div className="space-y-2">
      <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        {kindLabel}
      </p>
      <div
        aria-disabled
        className="cursor-not-allowed select-none space-y-1 rounded-md border border-border/60 bg-muted/40 px-3 py-2.5 text-muted-foreground"
      >
        {value.kind === "none" && (
          <p className="text-xs">No credential — tools are callable without an account.</p>
        )}

        {value.kind === "apikey" &&
          (value.placements.length > 0 ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {value.placements.map((placement, i: number) => (
                <PlacementLine key={i} placement={placement} />
              ))}
            </div>
          ) : null)}

        {value.kind === "oauth" &&
          (oauthMetadata === "discovered" ? (
            <p className="text-xs">
              OAuth metadata is discovered from this server when you connect an account.
            </p>
          ) : (
            <div className="space-y-1">
              {value.authorizationUrl ? (
                <SpecField label="Authorize" value={value.authorizationUrl} />
              ) : null}
              {value.tokenUrl ? <SpecField label="Token" value={value.tokenUrl} /> : null}
              {value.scopes.length > 0 ? (
                <SpecField label="Scopes" value={value.scopes.join(", ")} />
              ) : null}
            </div>
          ))}
      </div>

      <p className="text-[11px] text-muted-foreground">Pulled from spec. Remove to override.</p>
    </div>
  );
}
