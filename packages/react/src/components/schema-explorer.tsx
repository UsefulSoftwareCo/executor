import { useState, useCallback } from "react";
import { ChevronRight } from "lucide-react";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";

// ---------------------------------------------------------------------------
// JSON Schema types (subset we render)
// ---------------------------------------------------------------------------

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
  description?: string;
  title?: string;
  default?: unknown;
  nullable?: boolean;
  format?: string;
};

export const safeSchemaValueLabel = (value: unknown): string => {
  if (typeof value === "bigint") return `${value.toString()}n`;
  try {
    const label = JSON.stringify(value);
    if (label === undefined) return String(value);
    return label.length > 120 ? `${label.slice(0, 117)}...` : label;
  } catch {
    return "[unavailable]";
  }
};

// ---------------------------------------------------------------------------
// Ref resolution — lazy, only on expand
// ---------------------------------------------------------------------------

const resolveRef = (ref: string, root: JsonSchema): JsonSchema | null => {
  const name = ref.match(/^#\/\$defs\/(.+)$/)?.[1];
  if (!name || !root.$defs) return null;
  return root.$defs[name] ?? null;
};

const getRefName = (ref: string): string | undefined => ref.match(/^#\/\$defs\/(.+)$/)?.[1];

/**
 * Fully resolve a schema, following $ref and unwrapping single-variant
 * oneOf/anyOf so we can inspect the concrete shape.
 */
const deepResolve = (schema: JsonSchema, root: JsonSchema): JsonSchema => {
  let s = schema;
  if (s.$ref) {
    const resolved = resolveRef(s.$ref, root);
    if (resolved) s = resolved;
  }
  // Unwrap single-variant unions
  if (s.oneOf?.length === 1) s = deepResolve(s.oneOf[0]!, root);
  if (s.anyOf?.length === 1) s = deepResolve(s.anyOf[0]!, root);
  return s;
};

// ---------------------------------------------------------------------------
// Type label — human readable, shows ref names
// ---------------------------------------------------------------------------

// oxlint-disable-next-line only-used-in-recursion
const getTypeLabel = (schema: JsonSchema, root: JsonSchema): string => {
  if (schema.$ref) {
    return getRefName(schema.$ref) ?? "ref";
  }

  if (schema.const !== undefined) return safeSchemaValueLabel(schema.const);

  if (schema.enum) {
    if (schema.enum.length <= 3) {
      return schema.enum.map((v) => safeSchemaValueLabel(v)).join(" | ");
    }
    return `enum (${schema.enum.length})`;
  }

  if (schema.oneOf) {
    if (schema.oneOf.length === 1) return getTypeLabel(schema.oneOf[0]!, root);
    const labels = schema.oneOf.slice(0, 3).map((s) => getTypeLabel(s, root));
    if (schema.oneOf.length > 3) labels.push("…");
    return labels.join(" | ");
  }

  if (schema.anyOf) {
    if (schema.anyOf.length === 1) return getTypeLabel(schema.anyOf[0]!, root);
    const labels = schema.anyOf.slice(0, 3).map((s) => getTypeLabel(s, root));
    if (schema.anyOf.length > 3) labels.push("…");
    return labels.join(" | ");
  }

  if (schema.allOf) {
    // If any allOf member is a named ref, show that
    for (const s of schema.allOf) {
      if (s.$ref) {
        const name = getRefName(s.$ref);
        if (name) return name;
      }
    }
    return "object";
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

  if (types.includes("array")) {
    if (schema.items && !Array.isArray(schema.items)) {
      return `${getTypeLabel(schema.items, root)}[]`;
    }
    return "array";
  }

  if (types.includes("object")) {
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      return `Record<string, ${getTypeLabel(schema.additionalProperties, root)}>`;
    }
    return "object";
  }

  if (types.length === 1) {
    const t = types[0]!;
    if (schema.format) return `${t}<${schema.format}>`;
    return t;
  }
  if (types.length > 1) return types.join(" | ");

  return "any";
};

// ---------------------------------------------------------------------------
// Expandability check — conservative, resolves deeply
// ---------------------------------------------------------------------------

const getChildCount = (schema: JsonSchema, root: JsonSchema): number => {
  const s = deepResolve(schema, root);

  if (s.properties) return Object.keys(s.properties).length;

  if (s.items && !Array.isArray(s.items)) {
    const itemResolved = deepResolve(s.items, root);
    if (itemResolved.properties) return Object.keys(itemResolved.properties).length;
    return 0;
  }

  if (s.allOf) {
    const merged = mergeAllOf(s.allOf, root);
    if (merged.properties) return Object.keys(merged.properties).length;
    return 0;
  }

  if (s.oneOf && s.oneOf.length > 1) return s.oneOf.length;
  if (s.anyOf && s.anyOf.length > 1) return s.anyOf.length;

  if (s.additionalProperties && typeof s.additionalProperties === "object") return 1;

  return 0;
};

const isExpandable = (schema: JsonSchema, root: JsonSchema): boolean =>
  getChildCount(schema, root) > 0;

// ---------------------------------------------------------------------------
// Merge allOf
// ---------------------------------------------------------------------------

const mergeAllOf = (schemas: JsonSchema[], root: JsonSchema): JsonSchema => {
  const merged: JsonSchema = { type: "object", properties: {}, required: [] };
  for (const s of schemas) {
    const resolved = deepResolve(s, root);
    if (resolved.properties) {
      merged.properties = { ...merged.properties, ...resolved.properties };
    }
    if (resolved.required) {
      merged.required = [...(merged.required ?? []), ...resolved.required];
    }
    if (resolved.description && !merged.description) {
      merged.description = resolved.description;
    }
  }
  return merged;
};

// ---------------------------------------------------------------------------
// Type label styling — plain text, no colored pills
// ---------------------------------------------------------------------------

const typeClasses = "font-mono text-xs leading-5 text-muted-foreground";

// ---------------------------------------------------------------------------
// PropertyRow
// ---------------------------------------------------------------------------

function PropertyRow(props: {
  name: string;
  schema: JsonSchema;
  root: JsonSchema;
  required: boolean;
  depth: number;
  isLast?: boolean;
  /** Hide the required/optional badge entirely (e.g. for union variants) */
  hideRequiredBadge?: boolean;
}) {
  const { name, schema, root, required, depth, hideRequiredBadge } = props;
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<JsonSchema | null>(null);

  const expandable = isExpandable(schema, root);
  const typeLabel = getTypeLabel(schema, root);
  const description =
    schema.description ?? (schema.$ref ? resolveRef(schema.$ref, root)?.description : undefined);

  const handleToggle = useCallback(() => {
    if (!open && !resolved && schema.$ref) {
      setResolved(resolveRef(schema.$ref, root));
    }
    setOpen((v) => !v);
  }, [open, resolved, schema, root]);

  const childSchema = schema.$ref ? (resolved ?? resolveRef(schema.$ref, root) ?? schema) : schema;

  return (
    <div>
      <div
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        onClick={expandable ? handleToggle : undefined}
        onKeyDown={
          expandable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleToggle();
                }
              }
            : undefined
        }
        className={[
          "flex items-start gap-2 py-2.5 px-4",
          expandable ? "cursor-pointer hover:bg-accent/40 transition-colors" : "",
        ].join(" ")}
        style={depth > 0 ? { paddingLeft: `${depth * 16 + 16}px` } : undefined}
      >
        {/* Chevron or dot */}
        <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
          {expandable ? (
            <ChevronRight
              className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150"
              style={open ? { transform: "rotate(90deg)" } : undefined}
            />
          ) : (
            <span className="size-1 rounded-full bg-muted-foreground/40" />
          )}
        </div>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="font-medium text-foreground text-sm">{name}</p>
          <p className={typeClasses}>{typeLabel}</p>
          {!hideRequiredBadge &&
            (required ? (
              <p className="text-xs leading-5 font-medium text-orange-600 dark:text-orange-400">
                required
              </p>
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">optional</p>
            ))}
          {schema.default !== undefined && (
            <p className="text-xs leading-5 text-muted-foreground">
              = {safeSchemaValueLabel(schema.default)}
            </p>
          )}
        </div>
      </div>

      {/* Description — below the row */}
      {description && (
        <p
          className="pr-4 pb-2.5 text-sm leading-5 text-muted-foreground"
          style={{ paddingLeft: `${depth * 16 + 36}px` }}
        >
          {description}
        </p>
      )}

      {/* Children — rendered lazily on expand */}
      {open && expandable && (
        <div className="border-l border-border/60" style={{ marginLeft: `${depth * 16 + 22}px` }}>
          <PropertyChildren schema={childSchema} root={root} depth={depth + 1} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PropertyChildren — renders sub-properties
// ---------------------------------------------------------------------------

function PropertyChildren(props: { schema: JsonSchema; root: JsonSchema; depth: number }) {
  const { schema: rawSchema, root, depth } = props;

  if (depth > 6) {
    return <p className="px-4 py-2 text-sm text-muted-foreground">Nested too deep to display.</p>;
  }

  const schema = deepResolve(rawSchema, root);
  const required = new Set(schema.required ?? []);

  // Object properties
  if (schema.properties && Object.keys(schema.properties).length > 0) {
    const entries = Object.entries(schema.properties);
    entries.sort(([a], [b]) => {
      const ar = required.has(a);
      const br = required.has(b);
      if (ar !== br) return ar ? -1 : 1;
      return a.localeCompare(b);
    });
    return (
      <div className="divide-y divide-border/50">
        {entries.map(([key, value], i) => (
          <PropertyRow
            key={key}
            name={key}
            schema={value}
            root={root}
            required={required.has(key)}
            depth={depth}
            isLast={i === entries.length - 1}
          />
        ))}
      </div>
    );
  }

  // Array items
  if (schema.items && !Array.isArray(schema.items)) {
    const itemSchema = deepResolve(schema.items, root);
    if (itemSchema.properties && Object.keys(itemSchema.properties).length > 0) {
      return <PropertyChildren schema={itemSchema} root={root} depth={depth} />;
    }
    return <PropertyRow name="items" schema={schema.items} root={root} required depth={depth} />;
  }

  // allOf
  if (schema.allOf) {
    const merged = mergeAllOf(schema.allOf, root);
    if (merged.properties && Object.keys(merged.properties).length > 0) {
      return <PropertyChildren schema={merged} root={root} depth={depth} />;
    }
  }

  // oneOf / anyOf (only if multiple) — these are choices, not required fields
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants && variants.length > 1) {
    const label = schema.oneOf ? "One of" : "Any of";
    return (
      <div>
        <p
          className="px-4 py-2 text-xs font-medium uppercase tracking-widest text-muted-foreground"
          style={depth > 0 ? { paddingLeft: `${depth * 16 + 16}px` } : undefined}
        >
          {label}
        </p>
        <div className="divide-y divide-border/50">
          {variants.map((variant, i) => (
            <PropertyRow
              key={i}
              name={variant.title ?? `option ${i + 1}`}
              schema={variant}
              root={root}
              required={false}
              depth={depth}
              hideRequiredBadge
            />
          ))}
        </div>
      </div>
    );
  }

  // Record / additionalProperties
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return (
      <PropertyRow
        name="[key]"
        schema={schema.additionalProperties}
        root={root}
        required
        depth={depth}
      />
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Count top-level fields for the header subtitle
// ---------------------------------------------------------------------------

const countTopLevelFields = (schema: JsonSchema): number => {
  const resolved = deepResolve(schema, schema);
  if (resolved.properties) return Object.keys(resolved.properties).length;
  if (resolved.allOf) {
    const merged = mergeAllOf(resolved.allOf, schema);
    return merged.properties ? Object.keys(merged.properties).length : 0;
  }
  if (resolved.oneOf && resolved.oneOf.length > 1) return resolved.oneOf.length;
  if (resolved.anyOf && resolved.anyOf.length > 1) return resolved.anyOf.length;
  return 0;
};

// ---------------------------------------------------------------------------
// SchemaExplorer — main export
// ---------------------------------------------------------------------------

export function SchemaExplorer(props: { schema: unknown; title?: string }) {
  const schema = props.schema as JsonSchema | undefined;
  if (!schema) return null;

  const hasContent = isExpandable(schema, schema);
  const title = props.title;

  if (!hasContent) {
    const typeLabel = getTypeLabel(schema, schema);
    return (
      <CardStack>
        {title && <CardStackHeader>{title}</CardStackHeader>}
        <CardStackContent>
          <div className="flex items-center gap-2 px-4 py-3">
            <span className={typeClasses}>{typeLabel}</span>
          </div>
        </CardStackContent>
      </CardStack>
    );
  }

  const fieldCount = countTopLevelFields(schema);
  const countLabel =
    fieldCount > 0 ? `${fieldCount} ${fieldCount === 1 ? "field" : "fields"}` : null;

  return (
    <CardStack>
      {title && (
        <CardStackHeader
          rightSlot={
            countLabel ? (
              <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                {countLabel}
              </span>
            ) : undefined
          }
        >
          {title}
        </CardStackHeader>
      )}
      <CardStackContent>
        <PropertyChildren schema={schema} root={schema} depth={0} />
      </CardStackContent>
    </CardStack>
  );
}
