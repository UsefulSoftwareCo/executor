import { useEffect, useId, useState } from "react";
import type { Json } from "@executor-js/sdk";
import { Option, Schema } from "effect";
import { Button } from "../components/button.tsx";
import { Checkbox } from "../components/checkbox.tsx";
import { Input } from "../components/input.tsx";
import { Label } from "../components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";
import { Textarea } from "../components/textarea.tsx";
import { cn } from "../lib/utils.ts";
import { display, isSchema, text, type JsonSchema } from "./json-schema.ts";
import { humanize } from "./tool-schema.tsx";

type JsonObject = Schema.JsonObject;

const isJson = Schema.is(Schema.Json);
const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const maxDepth = 8;
const localRef = /^#\/(?:\$defs|definitions)\/(.+)$/;

export function resolveSchema(schema: JsonSchema, root: JsonSchema, depth = 0): JsonSchema {
  if (depth > maxDepth) return schema;
  const ref = typeof schema.$ref === "string" ? schema.$ref.match(localRef)?.[1] : undefined;
  if (ref !== undefined) {
    const definitions = isSchema(root.$defs)
      ? root.$defs
      : isSchema(root.definitions)
        ? root.definitions
        : {};
    const target = definitions[ref];
    if (!isSchema(target)) return schema;
    const { $ref: _ref, ...rest } = schema;
    return resolveSchema({ ...target, ...rest }, root, depth + 1);
  }
  if (isSchema(schema.properties)) return schema;
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf;
  if (!Array.isArray(union)) return schema;
  const variants = union.filter(isSchema).filter((variant) => variant.type !== "null");
  const [variant] = variants;
  if (variants.length !== 1 || variant === undefined) return schema;
  const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = schema;
  return resolveSchema({ ...variant, ...rest }, root, depth + 1);
}

const primaryType = (schema: JsonSchema): string | undefined =>
  Array.isArray(schema.type)
    ? schema.type.find((type): type is string => typeof type === "string" && type !== "null")
    : typeof schema.type === "string"
      ? schema.type
      : isSchema(schema.properties)
        ? "object"
        : undefined;

const unsupported = (schema: JsonSchema, depth: number) =>
  depth > maxDepth ||
  typeof schema.$ref === "string" ||
  Array.isArray(schema.anyOf) ||
  Array.isArray(schema.oneOf) ||
  Array.isArray(schema.allOf) ||
  Array.isArray(schema.items);

const properties = (schema: JsonSchema) =>
  Object.entries(isSchema(schema.properties) ? schema.properties : {}).flatMap(([name, value]) =>
    isSchema(value) ? [{ name, schema: value }] : [],
  );

const requiredNames = (schema: JsonSchema) =>
  new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );

export function isRenderableObjectSchema(schema: unknown): boolean {
  if (!isSchema(schema)) return false;
  const resolved = resolveSchema(schema, schema);
  if (unsupported(resolved, 0) || primaryType(resolved) !== "object") return false;
  return properties(resolved).length > 0 || resolved.additionalProperties === false;
}

function defaultValue(schema: JsonSchema, root: JsonSchema): Json {
  const resolved = resolveSchema(schema, root);
  if (isJson(resolved.default)) return resolved.default;
  if (isJson(resolved.const)) return resolved.const;
  if (Array.isArray(resolved.enum) && isJson(resolved.enum[0])) return resolved.enum[0];
  switch (primaryType(resolved)) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "object":
      return {};
    case "array":
      return [];
    default:
      return null;
  }
}

const pathOf = (parent: string, name: string) => (parent === "" ? name : `${parent}/${name}`);

const isEmpty = (value: Json | undefined) => value === undefined || value === null || value === "";

const nestedObject = (schema: JsonSchema, depth: number) =>
  !unsupported(schema, depth) &&
  !Array.isArray(schema.enum) &&
  !("const" in schema) &&
  primaryType(schema) === "object" &&
  isSchema(schema.properties);

const itemList = (schema: JsonSchema, depth: number) =>
  !unsupported(schema, depth) &&
  !Array.isArray(schema.enum) &&
  !("const" in schema) &&
  primaryType(schema) === "array" &&
  isSchema(schema.items);

export function missingRequiredFields(schema: unknown, value: Json): readonly string[] {
  if (!isSchema(schema)) return [];
  const within = (node: JsonSchema, current: Json, path: string, depth: number): string[] => {
    if (nestedObject(node, depth)) return fields(node, current, path, depth + 1);
    if (!itemList(node, depth) || !Array.isArray(current) || !isSchema(node.items)) return [];
    const item = resolveSchema(node.items, schema);
    return current.flatMap((entry, index) => within(item, entry, `${path}/${index}`, depth + 1));
  };
  const fields = (node: JsonSchema, current: Json, parent: string, depth: number): string[] => {
    const required = requiredNames(node);
    const record = isObject(current) ? current : {};
    return properties(node).flatMap((field) => {
      const path = pathOf(parent, field.name);
      const item = record[field.name];
      if (required.has(field.name) && isEmpty(item)) return [path];
      return item === undefined
        ? []
        : within(resolveSchema(field.schema, schema), item, path, depth);
    });
  };
  return fields(resolveSchema(schema, schema), value, "", 0);
}

interface FormContext {
  readonly root: JsonSchema;
  readonly id: string;
  readonly missing: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onInvalidChange: (path: string, invalid: boolean) => void;
}

export function ToolInputForm({
  schema,
  value,
  onChange,
  missing,
  disabled,
  onInvalidChange,
}: {
  readonly schema: unknown;
  readonly value: Json;
  readonly onChange: (next: Json) => void;
  readonly missing: readonly string[];
  readonly disabled: boolean;
  readonly onInvalidChange: (path: string, invalid: boolean) => void;
}) {
  const id = useId();
  const root = isSchema(schema) ? schema : {};
  const resolved = resolveSchema(root, root);
  if (properties(resolved).length === 0)
    return (
      <p className="rounded-lg border bg-card px-4 py-3.5 text-[13px] text-muted-foreground">
        This tool doesn't need any inputs.
      </p>
    );
  return (
    <div className="rounded-lg border bg-card px-4 py-4">
      <ObjectFields
        schema={resolved}
        value={isObject(value) ? value : {}}
        onChange={onChange}
        path=""
        depth={0}
        context={{ root, id, missing: new Set(missing), disabled, onInvalidChange }}
      />
    </div>
  );
}

function ObjectFields({
  schema,
  value,
  onChange,
  path,
  depth,
  context,
}: {
  readonly schema: JsonSchema;
  readonly value: JsonObject;
  readonly onChange: (next: JsonObject) => void;
  readonly path: string;
  readonly depth: number;
  readonly context: FormContext;
}) {
  const required = requiredNames(schema);
  const fields = properties(schema);
  const shown = fields
    .filter((field) => required.has(field.name) || field.name in value)
    .sort((a, b) => Number(required.has(b.name)) - Number(required.has(a.name)));
  const addable = fields.filter((field) => !required.has(field.name) && !(field.name in value));
  return (
    <div className="flex flex-col gap-4">
      {shown.map((field) => (
        <Field
          key={field.name}
          name={field.name}
          schema={field.schema}
          required={required.has(field.name)}
          value={value[field.name]}
          onChange={(next) => onChange({ ...value, [field.name]: next })}
          onRemove={() => {
            const { [field.name]: _removed, ...rest } = value;
            onChange(rest);
          }}
          path={pathOf(path, field.name)}
          depth={depth}
          context={context}
        />
      ))}
      {addable.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {addable.map((field) => (
            <Button
              key={field.name}
              type="button"
              size="xs"
              variant="outline"
              disabled={context.disabled}
              onClick={() =>
                onChange({ ...value, [field.name]: defaultValue(field.schema, context.root) })
              }
            >
              + {humanize(field.name)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ControlProps {
  readonly schema: JsonSchema;
  readonly value: Json | undefined;
  readonly onChange: (next: Json) => void;
  readonly id: string;
  readonly label: string;
  readonly named?: boolean;
  readonly required?: boolean;
  readonly invalid: boolean;
  readonly describedBy: string | undefined;
  readonly path: string;
  readonly depth: number;
  readonly context: FormContext;
}

function Field({
  name,
  schema,
  required,
  value,
  onChange,
  onRemove,
  path,
  depth,
  context,
}: {
  readonly name: string;
  readonly schema: JsonSchema;
  readonly required: boolean;
  readonly value: Json | undefined;
  readonly onChange: (next: Json) => void;
  readonly onRemove: () => void;
  readonly path: string;
  readonly depth: number;
  readonly context: FormContext;
}) {
  const resolved = resolveSchema(schema, context.root);
  const label = humanize(name);
  const id = `${context.id}-${path}`;
  const invalid = context.missing.has(path);
  const description = text(resolved.description);
  const describedBy =
    [invalid ? `${id}-error` : undefined, description === undefined ? undefined : `${id}-help`]
      .filter((part) => part !== undefined)
      .join(" ") || undefined;
  const control = {
    schema: resolved,
    value,
    onChange,
    id,
    label,
    required,
    invalid,
    describedBy,
    path,
    depth,
    context,
  };
  const boolean =
    !unsupported(resolved, depth) &&
    !Array.isArray(resolved.enum) &&
    !("const" in resolved) &&
    primaryType(resolved) === "boolean";
  const actions = required ? (
    <span className="text-[11px] text-muted-foreground">Required</span>
  ) : (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="h-5 px-1.5 text-muted-foreground"
      aria-label={`Remove ${label}`}
      disabled={context.disabled}
      onClick={onRemove}
    >
      Remove
    </Button>
  );
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {boolean ? (
        <div className="flex items-center gap-2">
          <Checkbox
            id={id}
            checked={(value ?? defaultValue(resolved, context.root)) === true}
            disabled={context.disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onCheckedChange={(checked) => onChange(checked === true)}
          />
          <Label htmlFor={id} className="text-[13px]">
            {label}
          </Label>
          <span className="ml-auto">{actions}</span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Label htmlFor={id} className="text-[13px]">
              {label}
            </Label>
            <span className="ml-auto">{actions}</span>
          </div>
          <Control {...control} />
        </>
      )}
      {description !== undefined && (
        <p id={`${id}-help`} className="text-[11px] leading-4 text-muted-foreground wrap-anywhere">
          {description}
        </p>
      )}
      {invalid && (
        <p id={`${id}-error`} className="text-[11px] text-destructive">
          Enter a value for {label}.
        </p>
      )}
    </div>
  );
}

function useReportInvalid(context: FormContext, path: string, invalid: boolean) {
  const { onInvalidChange } = context;
  useEffect(() => {
    if (!invalid) return;
    onInvalidChange(path, true);
    return () => onInvalidChange(path, false);
  }, [onInvalidChange, path, invalid]);
}

function Control(props: ControlProps) {
  const { schema, value, onChange, id, invalid, describedBy, context } = props;
  const a11y = {
    id,
    "aria-label": props.named === true ? props.label : undefined,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
  };
  if (unsupported(schema, props.depth)) return <JsonControl {...props} />;
  if ("const" in schema)
    return (
      <Input
        {...a11y}
        className="font-mono text-xs"
        value={display(schema.const)}
        disabled
        readOnly
      />
    );
  if (Array.isArray(schema.enum)) {
    const options = schema.enum;
    const current = value === undefined ? schema.default : value;
    const selected = options.findIndex((option) => option === current);
    return (
      <Select
        value={selected >= 0 ? String(selected) : ""}
        disabled={context.disabled || options.length === 0}
        onValueChange={(index) => {
          const option = options[Number(index)];
          if (isJson(option)) onChange(option);
        }}
      >
        <SelectTrigger {...a11y} className="w-full">
          <SelectValue placeholder={options.length === 0 ? "No options available" : "Choose…"} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option, index) => (
            <SelectItem key={display(option)} value={String(index)}>
              {display(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  const type = primaryType(schema);
  if (type === "number" || type === "integer")
    return <NumberControl {...props} integer={type === "integer"} />;
  if (type === "string")
    return (
      <Input
        {...a11y}
        type={
          schema.format === "email"
            ? "email"
            : schema.format === "uri" || schema.format === "url"
              ? "url"
              : schema.format === "date"
                ? "date"
                : "text"
        }
        value={typeof value === "string" ? value : ""}
        placeholder={schema.default === undefined ? undefined : display(schema.default)}
        disabled={context.disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  if (type === "array" && isSchema(schema.items))
    return <ArrayControl {...props} items={schema.items} />;
  if (type === "object" && isSchema(schema.properties))
    return (
      <div role="group" aria-label={props.label} className="ml-1.5 border-l pl-4">
        <ObjectFields
          schema={schema}
          value={isObject(value) ? value : {}}
          onChange={onChange}
          path={props.path}
          depth={props.depth + 1}
          context={context}
        />
      </div>
    );
  return <JsonControl {...props} />;
}

function NumberControl({
  value,
  onChange,
  id,
  label,
  named,
  required,
  invalid,
  describedBy,
  path,
  context,
  schema,
  integer,
}: ControlProps & { readonly integer: boolean }) {
  const [draft, setDraft] = useState<string>();
  const shown = draft ?? (typeof value === "number" ? String(value) : "");
  const parse = (raw: string) => {
    if (raw.trim() === "") return undefined;
    const number = Number(raw);
    return Number.isFinite(number) && (!integer || Number.isInteger(number)) ? number : undefined;
  };
  const empty = draft !== undefined && draft.trim() === "";
  const malformed =
    draft !== undefined && parse(draft) === undefined && (!empty || required !== true);
  useReportInvalid(context, path, malformed);
  return (
    <>
      <Input
        id={id}
        type="number"
        aria-label={named === true ? label : undefined}
        inputMode={integer ? "numeric" : "decimal"}
        step={integer ? 1 : "any"}
        value={shown}
        placeholder={schema.default === undefined ? undefined : display(schema.default)}
        disabled={context.disabled}
        aria-invalid={invalid || malformed || undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          setDraft(event.target.value);
          const number = parse(event.target.value);
          if (number !== undefined) onChange(number);
          else if (event.target.value.trim() === "") onChange(null);
        }}
        onBlur={() => {
          if (!malformed) setDraft(undefined);
        }}
      />
      {malformed && (
        <p className="text-[11px] text-destructive">
          {empty
            ? `Enter ${integer ? "a whole number" : "a number"} or remove this field.`
            : `Enter ${integer ? "a whole number" : "a number"}.`}
        </p>
      )}
    </>
  );
}

function ArrayControl({
  items,
  value,
  onChange,
  id,
  label,
  path,
  depth,
  context,
}: ControlProps & { readonly items: JsonSchema }) {
  const list = Array.isArray(value) ? value : [];
  const item = resolveSchema(items, context.root);
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-2">
      {list.map((entry, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- list items have no identity beyond position
        <div key={index} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Control
              schema={item}
              value={entry}
              onChange={(next) => onChange(list.map((old, i) => (i === index ? next : old)))}
              id={`${id}-${index}`}
              label={`${label} ${index + 1}`}
              named
              invalid={false}
              describedBy={undefined}
              path={`${path}/${index}`}
              depth={depth + 1}
              context={context}
            />
          </div>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="mt-1.5 text-muted-foreground"
            aria-label={`Remove ${label} ${index + 1}`}
            disabled={context.disabled}
            onClick={() => onChange(list.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="self-start"
        disabled={context.disabled}
        onClick={() => onChange([...list, defaultValue(items, context.root)])}
      >
        + Add {label.toLowerCase()} item
      </Button>
    </div>
  );
}

function JsonControl({
  schema,
  value,
  onChange,
  id,
  label,
  named,
  invalid,
  describedBy,
  path,
  context,
}: ControlProps) {
  const serialized = JSON.stringify(value ?? defaultValue(schema, context.root), null, 2);
  const [draft, setDraft] = useState<string>();
  const shown = draft ?? serialized;
  const malformed = draft !== undefined && Option.isNone(decodeJson(draft));
  useReportInvalid(context, path, malformed);
  return (
    <>
      <Textarea
        id={id}
        aria-label={named === true ? label : undefined}
        className="min-h-20 font-mono text-xs"
        spellCheck={false}
        value={shown}
        disabled={context.disabled}
        aria-invalid={invalid || malformed || undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          setDraft(event.target.value);
          const decoded = decodeJson(event.target.value);
          if (Option.isSome(decoded)) onChange(decoded.value);
        }}
        onBlur={() => {
          if (!malformed) setDraft(undefined);
        }}
      />
      <p className={cn("text-[11px]", malformed ? "text-destructive" : "text-muted-foreground")}>
        {malformed ? "Enter valid JSON." : "JSON"}
      </p>
    </>
  );
}
