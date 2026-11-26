import { useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Code } from "./code.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/tabs.tsx";
import { cn } from "../lib/utils.ts";
import { display, isSchema, text, type JsonSchema } from "./json-schema.ts";

const schemas = (value: unknown): readonly JsonSchema[] =>
  Array.isArray(value) ? value.filter(isSchema) : [];

const count = (value: unknown) => (typeof value === "number" ? value : undefined);

const acronyms = new Set(["id", "ids", "url", "uri", "api", "json", "http", "html", "sql", "mcp"]);

export function humanize(name: string) {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter((word) => word !== "")
    .map((word, i) =>
      acronyms.has(word.toLowerCase())
        ? word.toUpperCase()
        : i > 0 && /^[A-Z][a-z]/.test(word)
          ? word.toLowerCase()
          : word,
    );
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

const formats: Record<string, string> = {
  "date-time": "Date and time",
  date: "Date",
  time: "Time",
  email: "Email address",
  uri: "Link",
  url: "Link",
  uuid: "ID",
  binary: "File",
};

const plurals: Record<string, string> = {
  Text: "text values",
  Number: "numbers",
  "Whole number": "whole numbers",
  "Yes or no": "yes or no values",
  Group: "groups",
  Choice: "choices",
  "Any value": "values",
};

const primitive = (type: string, schema: JsonSchema) => {
  switch (type) {
    case "string":
      return formats[text(schema.format) ?? ""] ?? "Text";
    case "integer":
      return "Whole number";
    case "number":
      return "Number";
    case "boolean":
      return "Yes or no";
    case "null":
      return "Nothing";
    case "array": {
      const item = isSchema(schema.items) ? typeLabel(schema.items) : "Any value";
      return `List of ${plurals[item] ?? item.toLowerCase()}`;
    }
    case "object":
      return isSchema(schema.properties) ? "Group" : "Key and value pairs";
    default:
      return "Any value";
  }
};

function typeLabel(schema: JsonSchema): string {
  if (Array.isArray(schema.enum)) return "Choice";
  if ("const" in schema) return "Fixed value";
  const ref = text(schema.$ref);
  if (ref !== undefined) return humanize(ref.split("/").at(-1) ?? ref);
  const variants = [...schemas(schema.anyOf), ...schemas(schema.oneOf)].filter(
    (variant) => variant.type !== "null",
  );
  if (variants.length > 0) {
    const labels = [...new Set(variants.map(typeLabel))];
    return labels.join(" or ");
  }
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type): type is string => typeof type === "string");
    return [...new Set(types.filter((type) => type !== "null").map((t) => primitive(t, schema)))]
      .join(" or ")
      .replace(/^$/, "Nothing");
  }
  if (typeof schema.type === "string") return primitive(schema.type, schema);
  if (isSchema(schema.properties)) return "Group";
  return "Any value";
}

function flatten(schema: JsonSchema): JsonSchema {
  const alternatives = [...schemas(schema.anyOf), ...schemas(schema.oneOf)].filter(
    (variant) => variant.type !== "null",
  );
  const variants = [...schemas(schema.allOf), ...(alternatives.length === 1 ? alternatives : [])];
  if (variants.length === 0) return schema;
  return variants.reduce<JsonSchema>(
    (merged, variant) => ({ ...flatten(variant), ...merged }),
    schema,
  );
}

function hints(schema: JsonSchema): readonly string[] {
  const merged = flatten(schema);
  const result: string[] = [];
  const min = count(merged.minLength);
  const max = count(merged.maxLength);
  if (min !== undefined && max !== undefined) result.push(`${min}–${max} characters`);
  else if (max !== undefined) result.push(`Up to ${max} characters`);
  else if (min !== undefined && min > 1) result.push(`At least ${min} characters`);
  const minimum = count(merged.minimum);
  const maximum = count(merged.maximum);
  if (minimum !== undefined && maximum !== undefined)
    result.push(`Between ${minimum} and ${maximum}`);
  else if (minimum !== undefined) result.push(`At least ${minimum}`);
  else if (maximum !== undefined) result.push(`At most ${maximum}`);
  const minItems = count(merged.minItems);
  const maxItems = count(merged.maxItems);
  if (maxItems !== undefined) result.push(`Up to ${maxItems} items`);
  if (minItems !== undefined && minItems > 0) result.push(`At least ${minItems} items`);
  if ("default" in merged) result.push(`Defaults to ${display(merged.default)}`);
  if ("const" in merged) result.push(`Always ${display(merged.const)}`);
  return result;
}

interface Field {
  readonly name: string;
  readonly required: boolean;
  readonly schema: JsonSchema;
}

function fieldsOf(schema: JsonSchema): readonly Field[] {
  const merged = flatten(schema);
  const target =
    !isSchema(merged.properties) && isSchema(merged.items) ? flatten(merged.items) : merged;
  if (!isSchema(target.properties)) return [];
  const required = new Set(
    Array.isArray(target.required)
      ? target.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  return Object.entries(target.properties).flatMap(([name, value]) =>
    isSchema(value) ? [{ name, required: required.has(name), schema: value }] : [],
  );
}

function FieldRow({ field, depth }: { readonly field: Field; readonly depth: number }) {
  const merged = flatten(field.schema);
  const children = fieldsOf(field.schema);
  const [open, setOpen] = useState(depth < 2);
  const description = text(merged.description);
  const choices = Array.isArray(merged.enum) ? merged.enum : [];
  const label = humanize(field.name);
  const facts = hints(field.schema).filter((fact) => !fact.startsWith("Always "));
  if ("const" in merged)
    return (
      <li className="py-3 first:pt-0 last:pb-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium text-foreground">{label}</span>
          <code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {display(merged.const)}
          </code>
          <span className="ml-auto shrink-0 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            Set automatically
          </span>
        </div>
      </li>
    );
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        {label.toLowerCase().replaceAll(" ", "") !== field.name.toLowerCase() && (
          <code className="font-mono text-[11px] text-muted-foreground">{field.name}</code>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {typeLabel(field.schema)}
          </span>
          {field.required ? (
            <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
              Required
            </span>
          ) : (
            <span className="px-1.5 py-0.5 text-[11px] text-muted-foreground">Optional</span>
          )}
        </span>
      </div>
      {description !== undefined && (
        <p className="mt-1 text-[13px] leading-normal text-muted-foreground wrap-anywhere">
          {description}
        </p>
      )}
      {choices.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">
            {choices.length === 1 ? "Value:" : "One of:"}
          </span>
          {choices.map((choice) => (
            <code
              key={display(choice)}
              className="rounded-md border bg-background px-1.5 py-0.5 font-mono text-[11px]"
            >
              {display(choice)}
            </code>
          ))}
        </div>
      )}
      {facts.length > 0 && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">{facts.join(" · ")}</p>
      )}
      {children.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex items-center gap-1 rounded-sm text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-ring"
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={12}
              className={cn("transition-transform", open && "rotate-90")}
              aria-hidden
            />
            {open ? "Hide" : "Show"} {children.length} {children.length === 1 ? "field" : "fields"}
            {isSchema(merged.items) ? " in each item" : ""}
          </button>
          {open && (
            <FieldList fields={children} depth={depth + 1} className="mt-2 ml-1.5 border-l pl-4" />
          )}
        </div>
      )}
    </li>
  );
}

function FieldList({
  fields,
  depth,
  className,
}: {
  readonly fields: readonly Field[];
  readonly depth: number;
  readonly className?: string;
}) {
  return (
    <ul className={cn("divide-y", className)}>
      {fields.map((field) => (
        <FieldRow key={field.name} field={field} depth={depth} />
      ))}
    </ul>
  );
}

const sorted = (fields: readonly Field[]) =>
  [...fields].sort(
    (a, b) =>
      Number("const" in flatten(a.schema)) - Number("const" in flatten(b.schema)) ||
      Number(b.required) - Number(a.required),
  );

export function SchemaSection({
  title,
  subtitle,
  schema,
  empty,
  copyLabel,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly schema: unknown;
  readonly empty: ReactNode;
  readonly copyLabel: string;
}) {
  const document = isSchema(schema) ? schema : {};
  const fields = sorted(fieldsOf(document));
  const shapes =
    fields.length === 0
      ? [...schemas(document.anyOf), ...schemas(document.oneOf)]
          .map((variant) => sorted(fieldsOf(variant)))
          .filter((variant) => variant.length > 0)
      : [];
  const whole = fields.length === 0 && Object.keys(document).length > 0 ? typeLabel(document) : "";
  return (
    <section aria-label={title} className="mt-8">
      <Tabs defaultValue="fields" className="gap-3">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
          <TabsList className="h-7! shrink-0">
            <TabsTrigger value="fields" className="px-2.5 text-xs">
              Fields
            </TabsTrigger>
            <TabsTrigger value="json" className="px-2.5 text-xs">
              JSON
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="fields">
          <div className="rounded-lg border bg-card px-4 py-3.5">
            {fields.length > 0 ? (
              <FieldList fields={fields} depth={0} />
            ) : shapes.length > 0 ? (
              <ol className="divide-y">
                {shapes.map((shape, i) => (
                  // oxlint-disable-next-line react/no-array-index-key -- shapes have no identity beyond order
                  <li key={i} className="py-3.5 first:pt-0 last:pb-0">
                    <p className="mb-2.5 text-[11px] font-medium text-muted-foreground uppercase">
                      Option {i + 1} of {shapes.length}
                    </p>
                    <FieldList fields={shape} depth={0} />
                  </li>
                ))}
              </ol>
            ) : whole.includes(" or ") ? (
              <p className="text-[13px] text-muted-foreground">
                This can take one of several shapes. Open JSON to see them.
              </p>
            ) : whole !== "" && whole !== "Any value" && whole !== "Key and value pairs" ? (
              <p className="text-[13px] text-muted-foreground">
                {whole}
                {text(document.description) !== undefined && ` — ${text(document.description)}`}
              </p>
            ) : (
              <p className="text-[13px] text-muted-foreground">{empty}</p>
            )}
          </div>
        </TabsContent>
        <TabsContent value="json">
          <Code code={JSON.stringify(schema, null, 2)} copyable copyLabel={copyLabel} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
