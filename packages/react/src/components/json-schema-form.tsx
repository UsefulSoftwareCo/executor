import { useEffect, useMemo, useState } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { safeSchemaValueLabel } from "./schema-explorer";
import { Input } from "./input";
import { Switch } from "./switch";
import { NativeSelect, NativeSelectOption } from "./native-select";
import { Label } from "./label";
import { Textarea } from "./textarea";
import { Button } from "./button";
import { Badge } from "./badge";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// JsonSchemaForm — a dynamic form built from a tool's input JSON Schema. The
// single source of truth is the parent's args object (controlled `value`); this
// renders a pure view and emits a fully-rebuilt object on every edit. Anything
// the renderer can't express as a typed control falls back to a raw-JSON subtree
// editor, so no input shape is ever un-editable.
//
// Constraints honored: only wrapped design-system components (never raw
// <input>/<select>/<button>/<label>/<textarea>/<option>); no raw `JSON.parse`
// (parsing goes through `decodeJson`, an Option-returning Effect Schema decode);
// every callback param explicitly typed (tsgo can't infer through the generics).
// ---------------------------------------------------------------------------

// JSON Schema subset we render. Mirrors the type in `schema-explorer.tsx`; the
// ref-resolution helpers below mirror that file too (kept local to avoid a
// cross-file public-API coupling for ~25 lines).
type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  description?: unknown;
  title?: unknown;
  default?: unknown;
  nullable?: boolean;
  format?: string;
};

/** Decode a JSON string at the boundary. Effect Schema is used because the repo
 *  forbids raw `JSON.parse`; a malformed string yields `None`. */
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

/** Sentinel a field emits to ask its object parent to delete its key. */
const REMOVE = Symbol("json-schema-form/remove");

// --- Ref resolution (mirrors schema-explorer.tsx) --------------------------

const resolveRef = (ref: string, root: JsonSchema): JsonSchema | null => {
  const name = ref.match(/^#\/\$defs\/(.+)$/)?.[1];
  if (!name || !root.$defs) return null;
  return root.$defs[name] ?? null;
};

/** Fully resolve a schema, following `$ref` and unwrapping single-variant
 *  oneOf/anyOf so we can inspect the concrete shape. */
const deepResolve = (schema: JsonSchema, root: JsonSchema): JsonSchema => {
  let s = schema;
  if (s.$ref) {
    const resolved = resolveRef(s.$ref, root);
    if (resolved) s = resolved;
  }
  if (s.oneOf?.length === 1) s = deepResolve(s.oneOf[0]!, root);
  if (s.anyOf?.length === 1) s = deepResolve(s.anyOf[0]!, root);
  return s;
};

// --- Small schema utilities ------------------------------------------------

const asObjectSchema = (value: unknown): JsonSchema | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchema) : undefined;

const schemaTypes = (schema: JsonSchema): readonly string[] =>
  Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

/** The non-null primitive type for `type: ["string","null"]` / `nullable`. */
const primaryType = (schema: JsonSchema): string | undefined =>
  schemaTypes(schema).find((t: string) => t !== "null");

const schemaDescription = (schema: JsonSchema): string | undefined => {
  const d = schema.description;
  if (typeof d === "string") return d;
  if (Option.isOption(d) && Option.isSome(d) && typeof d.value === "string") return d.value;
  return undefined;
};

const DEFAULT_BY_TYPE: Record<string, () => unknown> = {
  string: () => "",
  number: () => 0,
  integer: () => 0,
  boolean: () => false,
  object: () => ({}),
  array: () => [],
};

/** Seed used when the user clicks "Add" for an optional property or array item.
 *  Never auto-injected on load — only on explicit add. */
export const defaultForSchema = (schema: JsonSchema, root: JsonSchema): unknown => {
  const s = deepResolve(schema, root);
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  const t = primaryType(s);
  const make = t ? DEFAULT_BY_TYPE[t] : undefined;
  return make ? make() : null;
};

/** True only when the schema resolves to a renderable object root (a `type:
 *  "object"` with `properties`). Otherwise the Form tab is disabled and the
 *  panel falls back to raw JSON. */
export const isRenderableObjectSchema = (
  schema: unknown,
  definitions?: Record<string, unknown>,
): boolean => {
  const obj = asObjectSchema(schema);
  if (!obj) return false;
  const root: JsonSchema = {
    $defs: (definitions ?? {}) as Record<string, JsonSchema>,
  };
  const resolved = deepResolve(obj, root);
  return resolved.type === "object" || resolved.properties !== undefined;
};

/** Required top-level fields not yet satisfied by `value` — a field counts as
 *  satisfied when it is present and not undefined/null/empty-string. Empty array
 *  ⇒ all required args supplied; drives the Run button's enabled state. */
export const missingRequiredFields = (
  schema: unknown,
  definitions: Record<string, unknown> | undefined,
  value: Record<string, unknown>,
): readonly string[] => {
  const obj = asObjectSchema(schema);
  if (!obj) return [];
  const root: JsonSchema = { $defs: (definitions ?? {}) as Record<string, JsonSchema> };
  const resolved = deepResolve(obj, root);
  const required = Array.isArray(resolved.required) ? resolved.required : [];
  return required.filter((key: string): boolean => {
    if (!(key in value)) return true;
    const v = value[key];
    return v === undefined || v === null || v === "";
  });
};

// --- Pure value transforms (unit-tested directly) --------------------------

/** Rebuild an object with `key` set to `next` — never mutates the input, never
 *  produces `undefined` values. */
export const setProperty = (
  value: Record<string, unknown>,
  key: string,
  next: unknown,
): Record<string, unknown> => ({ ...value, [key]: next });

/** Rebuild an object with `key` deleted. */
export const removeProperty = (
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const { [key]: _omit, ...rest } = value;
  return rest;
};

/** Apply a child field's emitted value to its object parent: the REMOVE sentinel
 *  deletes the key, anything else sets it. */
const applyChild = (
  value: Record<string, unknown>,
  key: string,
  next: unknown,
): Record<string, unknown> =>
  next === REMOVE ? removeProperty(value, key) : setProperty(value, key, next);

/** Coerce a number-input string to a JSON number, or `undefined` if not a finite
 *  number (caller keeps last-valid + marks invalid). */
export const coerceNumber = (raw: string, integer: boolean): number | undefined => {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return integer ? Math.trunc(n) : n;
};

// ---------------------------------------------------------------------------
// JsonSchemaForm — top-level object renderer
// ---------------------------------------------------------------------------

export function JsonSchemaForm(props: {
  readonly schema: unknown;
  readonly definitions?: Record<string, unknown>;
  readonly value: Record<string, unknown>;
  readonly onChange: (next: Record<string, unknown>) => void;
  readonly disabled?: boolean;
}): React.ReactElement {
  const { schema, definitions, value, onChange, disabled } = props;

  const root = useMemo<JsonSchema>(
    () => ({ $defs: (definitions ?? {}) as Record<string, JsonSchema> }),
    [definitions],
  );
  const resolved = useMemo<JsonSchema>(
    () => deepResolve(asObjectSchema(schema) ?? {}, root),
    [schema, root],
  );

  return (
    <ObjectFields
      schema={resolved}
      root={root}
      value={value}
      onChange={onChange}
      depth={0}
      disabled={disabled}
    />
  );
}

// ---------------------------------------------------------------------------
// ObjectFields — renders an object's properties (required first, then present
// optionals, then "Add" rows for absent optionals)
// ---------------------------------------------------------------------------

function ObjectFields(props: {
  readonly schema: JsonSchema;
  readonly root: JsonSchema;
  readonly value: Record<string, unknown>;
  readonly onChange: (next: Record<string, unknown>) => void;
  readonly depth: number;
  readonly idPrefix?: string;
  readonly disabled?: boolean;
}): React.ReactElement {
  const { schema, root, value, onChange, depth, idPrefix = "jsf", disabled } = props;

  const properties = schema.properties ?? {};
  const requiredSet = new Set(schema.required ?? []);
  const entries = Object.entries(properties);

  const present = entries.filter(
    ([key]: [string, JsonSchema]) => key in value || requiredSet.has(key),
  );
  const addable = entries.filter(
    ([key]: [string, JsonSchema]) => !requiredSet.has(key) && !(key in value),
  );

  // No properties → render nothing (no "takes no arguments" noise); a zero-arg
  // tool simply runs with an empty payload.
  if (entries.length === 0) {
    return <></>;
  }

  return (
    <div className="space-y-3">
      {present.map(([key, propSchema]: [string, JsonSchema]) => {
        const fieldId = `${idPrefix}-${key}`;
        return (
          <JsonSchemaField
            key={key}
            schema={propSchema}
            root={root}
            name={key}
            fieldId={fieldId}
            required={requiredSet.has(key)}
            value={value[key]}
            present={key in value}
            onChange={(next: unknown) => onChange(applyChild(value, key, next))}
            depth={depth}
            disabled={disabled}
          />
        );
      })}

      {addable.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {addable.map(([key, propSchema]: [string, JsonSchema]) => (
            <Button
              key={key}
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => onChange(setProperty(value, key, defaultForSchema(propSchema, root)))}
            >
              + {key}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// JsonSchemaField — dispatches one property to the right control
// ---------------------------------------------------------------------------

function JsonSchemaField(props: {
  readonly schema: JsonSchema;
  readonly root: JsonSchema;
  readonly name: string;
  readonly fieldId: string;
  readonly required: boolean;
  readonly value: unknown;
  /** Whether the key is present in the parent object (drives the Remove button). */
  readonly present: boolean;
  readonly onChange: (next: unknown) => void;
  readonly depth: number;
  readonly disabled?: boolean;
}): React.ReactElement {
  const { root, name, fieldId, required, value, present, onChange, depth, disabled } = props;
  const schema = deepResolve(props.schema, root);
  const description = schemaDescription(schema);

  const header = (
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor={fieldId} className="text-xs">
        <span>{name}</span>
        {required && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            required
          </Badge>
        )}
      </Label>
      {!required && present && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-5 px-1.5 text-muted-foreground"
          disabled={disabled}
          onClick={() => onChange(REMOVE)}
        >
          Remove
        </Button>
      )}
    </div>
  );

  const help = description ? (
    <p className="text-[11px] leading-4 text-muted-foreground">{description}</p>
  ) : null;

  return (
    <div className="space-y-1">
      {header}
      <FieldControl
        schema={schema}
        root={root}
        fieldId={fieldId}
        value={value}
        onChange={onChange}
        depth={depth}
        disabled={disabled}
      />
      {help}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FieldControl — the actual control for a resolved schema node
// ---------------------------------------------------------------------------

function FieldControl(props: {
  readonly schema: JsonSchema;
  readonly root: JsonSchema;
  readonly fieldId: string;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
  readonly depth: number;
  readonly disabled?: boolean;
}): React.ReactElement {
  const { schema, root, fieldId, value, onChange, depth, disabled } = props;

  // Recursion guard / unsupported constructs → raw-JSON subtree fallback.
  const unsupported =
    depth > 8 ||
    (schema.oneOf?.length ?? 0) > 1 ||
    (schema.anyOf?.length ?? 0) > 1 ||
    schema.allOf !== undefined ||
    Array.isArray(schema.items) ||
    (schema.$ref !== undefined && resolveRef(schema.$ref, root) === null);

  if (unsupported) {
    return (
      <JsonFallbackField
        schema={schema}
        root={root}
        fieldId={fieldId}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }

  // const — fixed value, shown disabled and auto-applied.
  if (schema.const !== undefined) {
    return (
      <ConstField fieldId={fieldId} constValue={schema.const} value={value} onChange={onChange} />
    );
  }

  // enum — native select. Optional/unset gets a leading empty option.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const options = schema.enum;
    const currentIndex = options.findIndex((o: unknown) => o === value);
    return (
      <NativeSelect
        id={fieldId}
        className="w-full text-xs"
        value={currentIndex >= 0 ? String(currentIndex) : ""}
        disabled={disabled}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
          const idx = Number(e.target.value);
          if (Number.isInteger(idx) && idx >= 0 && idx < options.length) onChange(options[idx]);
        }}
      >
        <NativeSelectOption value="">— select —</NativeSelectOption>
        {options.map((option: unknown, i: number) => (
          <NativeSelectOption key={i} value={String(i)}>
            {safeSchemaValueLabel(option)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  }

  const type = primaryType(schema);

  if (type === "boolean") {
    return (
      <div className="flex h-9 items-center">
        <Switch
          id={fieldId}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked: boolean) => onChange(checked)}
        />
      </div>
    );
  }

  if (type === "number" || type === "integer") {
    return (
      <NumberField
        schema={schema}
        fieldId={fieldId}
        value={value}
        onChange={onChange}
        integer={type === "integer"}
        disabled={disabled}
      />
    );
  }

  if (type === "string") {
    const inputType =
      schema.format === "email"
        ? "email"
        : schema.format === "uri" || schema.format === "url"
          ? "url"
          : schema.format === "date"
            ? "date"
            : "text";
    return (
      <Input
        id={fieldId}
        type={inputType}
        className="text-xs"
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      />
    );
  }

  if (type === "array" && schema.items && !Array.isArray(schema.items)) {
    return (
      <ArrayField
        itemSchema={schema.items}
        root={root}
        fieldId={fieldId}
        value={value}
        onChange={onChange}
        depth={depth}
        disabled={disabled}
      />
    );
  }

  if (type === "object" && schema.properties) {
    const objValue =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return (
      <div className="rounded-md border border-border/60 p-3">
        <ObjectFields
          schema={schema}
          root={root}
          value={objValue}
          onChange={(next: Record<string, unknown>) => onChange(next)}
          depth={depth + 1}
          idPrefix={fieldId}
          disabled={disabled}
        />
      </div>
    );
  }

  // Unknown / unsupported leaf → raw-JSON fallback.
  return (
    <JsonFallbackField
      schema={schema}
      root={root}
      fieldId={fieldId}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

// ---------------------------------------------------------------------------
// ConstField — a fixed value, shown disabled. The const is applied to the args
// via an effect (never a render-phase parent update, which React forbids).
// ---------------------------------------------------------------------------

function ConstField(props: {
  readonly fieldId: string;
  readonly constValue: unknown;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
}): React.ReactElement {
  const { fieldId, constValue, value, onChange } = props;
  useEffect(() => {
    if (value !== constValue) onChange(constValue);
  }, [value, constValue, onChange]);
  return (
    <Input
      id={fieldId}
      className="text-xs"
      value={safeSchemaValueLabel(constValue)}
      disabled
      readOnly
    />
  );
}

// ---------------------------------------------------------------------------
// NumberField — keeps a local draft so transient/invalid text doesn't clobber
// the last-valid number emitted upward
// ---------------------------------------------------------------------------

function NumberField(props: {
  readonly schema: JsonSchema;
  readonly fieldId: string;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
  readonly integer: boolean;
  readonly disabled?: boolean;
}): React.ReactElement {
  const { fieldId, value, onChange, integer, disabled } = props;
  const valueText = typeof value === "number" ? String(value) : "";
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? valueText;
  const invalid =
    draft !== null && draft.trim() !== "" && coerceNumber(draft, integer) === undefined;

  return (
    <Input
      id={fieldId}
      type="number"
      step={integer ? 1 : "any"}
      className="text-xs"
      value={display}
      disabled={disabled}
      aria-invalid={invalid}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value;
        setDraft(raw);
        const n = coerceNumber(raw, integer);
        if (n !== undefined) onChange(n);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

// ---------------------------------------------------------------------------
// ArrayField — single-`items` arrays; index-keyed add/remove
// ---------------------------------------------------------------------------

function ArrayField(props: {
  readonly itemSchema: JsonSchema;
  readonly root: JsonSchema;
  readonly fieldId: string;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
  readonly depth: number;
  readonly disabled?: boolean;
}): React.ReactElement {
  const { itemSchema, root, fieldId, value, onChange, depth, disabled } = props;
  const items = Array.isArray(value) ? value : [];

  const setItem = (index: number, next: unknown): void => {
    if (next === REMOVE) {
      onChange(items.filter((_item: unknown, i: number) => i !== index));
      return;
    }
    onChange(items.map((item: unknown, i: number) => (i === index ? next : item)));
  };

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      {items.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No items.</p>
      ) : (
        items.map((item: unknown, index: number) => {
          const itemId = `${fieldId}-${index}`;
          return (
            <div key={index} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <FieldControl
                  schema={deepResolve(itemSchema, root)}
                  root={root}
                  fieldId={itemId}
                  value={item}
                  onChange={(next: unknown) => setItem(index, next)}
                  depth={depth + 1}
                  disabled={disabled}
                />
              </div>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                disabled={disabled}
                onClick={() => setItem(index, REMOVE)}
              >
                Remove
              </Button>
            </div>
          );
        })
      )}
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() => onChange([...items, defaultForSchema(itemSchema, root)])}
      >
        + Add item
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// JsonFallbackField — raw-JSON editor for any subtree the form can't render.
// Holds its own draft string so invalid JSON is never emitted upward (a sibling
// is never clobbered with garbage); only valid JSON propagates.
// ---------------------------------------------------------------------------

function JsonFallbackField(props: {
  readonly schema: JsonSchema;
  readonly root: JsonSchema;
  readonly fieldId: string;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
  readonly disabled?: boolean;
}): React.ReactElement {
  const { schema, root, fieldId, value, onChange, disabled } = props;

  const serialized = useMemo(
    () => JSON.stringify(value ?? defaultForSchema(schema, root), null, 2),
    [value, schema, root],
  );
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? serialized;
  const invalid = draft !== null && Option.isNone(decodeJson(draft));

  return (
    <div className="space-y-1">
      <Textarea
        id={fieldId}
        className="font-mono text-xs"
        rows={4}
        spellCheck={false}
        value={display}
        disabled={disabled}
        aria-invalid={invalid}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
          const text = e.target.value;
          setDraft(text);
          const decoded = decodeJson(text);
          if (Option.isSome(decoded)) onChange(decoded.value);
        }}
        onBlur={() => setDraft(null)}
      />
      <p className={cn("text-[11px]", invalid ? "text-destructive" : "text-muted-foreground")}>
        {invalid ? "Invalid JSON" : "JSON"}
      </p>
    </div>
  );
}
