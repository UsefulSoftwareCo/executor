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
import { PlusIcon, XIcon } from "lucide-react";

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
    setRows((current: readonly AuthMethodRow[]) => [...current, { value: emptyApiKeyValue() }]);
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
          {list.rows.map((row: AuthMethodRow, index: number) => (
            <div
              key={index}
              className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  Method {index + 1}
                  {row.seedLabel ? ` · ${row.seedLabel}` : ""}
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
              <AuthTemplateEditor
                value={row.value}
                onChange={(next: AuthTemplateEditorValue) => list.setRowAt(index, next)}
                {...(allowedKinds ? { allowedKinds } : {})}
                {...(presets ? { presets } : {})}
                {...(oauthMetadata ? { oauthMetadata } : {})}
              />
            </div>
          ))}
        </div>
      )}
      {list.rows.length > 0 && props.footerHint ? (
        <p className="text-[11px] text-muted-foreground">{props.footerHint}</p>
      ) : null}
    </section>
  );
}
