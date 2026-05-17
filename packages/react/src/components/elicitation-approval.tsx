import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Match, Option } from "effect";

import { Checkbox } from "./checkbox";
import { Input } from "./input";
import { Label } from "./label";
import { NativeSelect, NativeSelectOption } from "./native-select";
import { Textarea } from "./textarea";

export type ElicitationAction = "accept" | "decline" | "cancel";
export type ElicitationFieldValue = string | number | boolean | string[];

type ElicitationSchemaField = {
  readonly name: string;
  readonly schema: Record<string, unknown>;
  readonly required: boolean;
};

type ElicitationFormSchema = {
  readonly fields: readonly ElicitationSchemaField[];
};

type SelectOption = {
  readonly value: string;
  readonly label: string;
};

export type ElicitationApprovalState = {
  readonly hasFields: boolean;
  readonly content: () => Record<string, unknown> | null;
  readonly fields: ReactNode;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const toOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const fieldLabel = (field: ElicitationSchemaField): string =>
  toOptionalString(field.schema.title) ?? field.name;

const fieldDescription = (field: ElicitationSchemaField): string | undefined =>
  toOptionalString(field.schema.description);

const enumOptions = (schema: Record<string, unknown>): readonly SelectOption[] => {
  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf)) {
    return oneOf.flatMap((item): SelectOption[] => {
      if (!isRecord(item) || typeof item.const !== "string") return [];
      return [{ value: item.const, label: toOptionalString(item.title) ?? item.const }];
    });
  }

  const values = schema.enum;
  if (!isStringArray(values)) return [];
  const labels = isStringArray(schema.enumNames) ? schema.enumNames : values;
  return values.map((value, index) => ({ value, label: labels[index] ?? value }));
};

const multiSelectOptions = (schema: Record<string, unknown>): readonly SelectOption[] => {
  const items = schema.items;
  if (!isRecord(items)) return [];

  const anyOf = items.anyOf;
  if (Array.isArray(anyOf)) {
    return anyOf.flatMap((item): SelectOption[] => {
      if (!isRecord(item) || typeof item.const !== "string") return [];
      return [{ value: item.const, label: toOptionalString(item.title) ?? item.const }];
    });
  }

  const values = items.enum;
  if (!isStringArray(values)) return [];
  const labels = isStringArray(items.enumNames) ? items.enumNames : values;
  return values.map((value, index) => ({ value, label: labels[index] ?? value }));
};

const parseElicitationFormSchema = (value: unknown): ElicitationFormSchema | null => {
  if (!isRecord(value) || !isRecord(value.properties)) return null;
  const required = isStringArray(value.required) ? value.required : [];
  const fields = Object.entries(value.properties).flatMap(
    ([name, schema]): ElicitationSchemaField[] =>
      isRecord(schema) ? [{ name, schema, required: required.includes(name) }] : [],
  );
  return fields.length > 0 ? { fields } : null;
};

const initialFieldValue = (field: ElicitationSchemaField): ElicitationFieldValue | undefined => {
  const value = field.schema.default;
  if (value === undefined) return undefined;
  const matched = Match.value(field.schema.type).pipe(
    Match.when("boolean", () => value === true),
    Match.when(
      (type: unknown) => type === "number" || type === "integer",
      () => {
        const numberValue = typeof value === "number" ? value : Number(value);
        return Number.isFinite(numberValue) ? numberValue : undefined;
      },
    ),
    Match.when("array", () => (isStringArray(value) ? value : undefined)),
    Match.option,
  );
  return Option.getOrElse(matched, () => (typeof value === "string" ? value : String(value)));
};

const initialFormValues = (
  formSchema: ElicitationFormSchema | null,
): Record<string, ElicitationFieldValue> => {
  const values: Record<string, ElicitationFieldValue> = {};
  for (const field of formSchema?.fields ?? []) {
    const value = initialFieldValue(field);
    if (value !== undefined) values[field.name] = value;
  }
  return values;
};

const isEmptyFormValue = (value: ElicitationFieldValue | undefined): boolean =>
  value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

const numericConstraint = (
  schema: Record<string, unknown>,
  key: "minimum" | "maximum",
): number | undefined => (typeof schema[key] === "number" ? schema[key] : undefined);

const lengthConstraint = (
  schema: Record<string, unknown>,
  key: "minLength" | "maxLength" | "minItems" | "maxItems",
): number | undefined => (typeof schema[key] === "number" ? schema[key] : undefined);

const validateEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const validateUrl = (value: string): boolean => {
  try {
    void new URL(value);
    return true;
  } catch {
    return false;
  }
};

const validateFieldValue = (
  field: ElicitationSchemaField,
  value: ElicitationFieldValue | undefined,
): { readonly value?: ElicitationFieldValue; readonly error?: string } => {
  if (isEmptyFormValue(value)) {
    return field.required ? { error: "This field is required." } : {};
  }

  if (field.schema.type === "boolean") {
    return typeof value === "boolean" ? { value } : { error: "Choose true or false." };
  }

  if (field.schema.type === "number" || field.schema.type === "integer") {
    const numberValue = typeof value === "number" ? value : Number(value);
    const typeLabel = field.schema.type === "integer" ? "an integer" : "a number";
    if (!Number.isFinite(numberValue)) return { error: `Must be ${typeLabel}.` };
    if (field.schema.type === "integer" && !Number.isInteger(numberValue)) {
      return { error: "Must be an integer." };
    }
    const minimum = numericConstraint(field.schema, "minimum");
    const maximum = numericConstraint(field.schema, "maximum");
    if (minimum !== undefined && numberValue < minimum) return { error: `Must be >= ${minimum}.` };
    if (maximum !== undefined && numberValue > maximum) return { error: `Must be <= ${maximum}.` };
    return { value: numberValue };
  }

  if (field.schema.type === "array") {
    const selected = Array.isArray(value) ? value : [];
    const options = multiSelectOptions(field.schema);
    const allowed = new Set(options.map((option) => option.value));
    if (!selected.every((item) => allowed.has(item))) return { error: "Choose a valid option." };
    const minItems = lengthConstraint(field.schema, "minItems");
    const maxItems = lengthConstraint(field.schema, "maxItems");
    if (minItems !== undefined && selected.length < minItems) {
      return { error: `Choose at least ${minItems} option${minItems === 1 ? "" : "s"}.` };
    }
    if (maxItems !== undefined && selected.length > maxItems) {
      return { error: `Choose at most ${maxItems} option${maxItems === 1 ? "" : "s"}.` };
    }
    return { value: selected };
  }

  const stringValue = String(value);
  const options = enumOptions(field.schema);
  if (options.length > 0 && !options.some((option) => option.value === stringValue)) {
    return { error: "Choose a valid option." };
  }
  const minLength = lengthConstraint(field.schema, "minLength");
  const maxLength = lengthConstraint(field.schema, "maxLength");
  if (minLength !== undefined && stringValue.length < minLength) {
    return { error: `Must be at least ${minLength} character${minLength === 1 ? "" : "s"}.` };
  }
  if (maxLength !== undefined && stringValue.length > maxLength) {
    return { error: `Must be at most ${maxLength} character${maxLength === 1 ? "" : "s"}.` };
  }
  if (field.schema.format === "email" && !validateEmail(stringValue)) {
    return { error: "Must be a valid email address." };
  }
  if (field.schema.format === "uri" && !validateUrl(stringValue)) {
    return { error: "Must be a valid URL." };
  }
  return { value: stringValue };
};

const buildElicitationContent = (
  formSchema: ElicitationFormSchema | null,
  formValues: Record<string, ElicitationFieldValue>,
): { readonly content: Record<string, unknown>; readonly errors: Record<string, string> } => {
  if (!formSchema) return { content: {}, errors: {} };

  const content: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of formSchema.fields) {
    const result = validateFieldValue(field, formValues[field.name]);
    if (result.error) {
      errors[field.name] = result.error;
      continue;
    }
    if (result.value !== undefined) content[field.name] = result.value;
  }
  return { content, errors };
};

export function useElicitationApproval(schema: unknown): ElicitationApprovalState {
  const formSchema = useMemo(() => parseElicitationFormSchema(schema), [schema]);
  const [formValues, setFormValues] = useState<Record<string, ElicitationFieldValue>>(() =>
    initialFormValues(formSchema),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setFormValues(initialFormValues(formSchema));
    setFieldErrors({});
  }, [formSchema]);

  const setFieldValue = (name: string, value: ElicitationFieldValue | undefined) => {
    setFormValues((prev) => {
      const next = { ...prev };
      if (value === undefined) {
        delete next[name];
      } else {
        next[name] = value;
      }
      return next;
    });
    setFieldErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  return {
    hasFields: Boolean(formSchema),
    content: () => {
      const result = buildElicitationContent(formSchema, formValues);
      setFieldErrors(result.errors);
      return Object.keys(result.errors).length > 0 ? null : result.content;
    },
    fields: formSchema ? (
      <ElicitationApprovalFields
        formSchema={formSchema}
        formValues={formValues}
        fieldErrors={fieldErrors}
        onChange={setFieldValue}
      />
    ) : null,
  };
}

function ElicitationApprovalFields({
  formSchema,
  formValues,
  fieldErrors,
  onChange,
}: {
  formSchema: ElicitationFormSchema;
  formValues: Record<string, ElicitationFieldValue>;
  fieldErrors: Record<string, string>;
  onChange: (name: string, value: ElicitationFieldValue | undefined) => void;
}) {
  return (
    <div data-testid="trusted-interaction-fields" className="space-y-3">
      <div>
        <div className="text-xs font-medium text-muted-foreground">Additional details</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          These values will be sent with approval.
        </div>
      </div>
      {formSchema.fields.map((field) => (
        <ElicitationApprovalField
          key={field.name}
          field={field}
          value={formValues[field.name]}
          error={fieldErrors[field.name]}
          onChange={(value) => onChange(field.name, value)}
        />
      ))}
    </div>
  );
}

function ElicitationApprovalField({
  field,
  value,
  error,
  onChange,
}: {
  field: ElicitationSchemaField;
  value: ElicitationFieldValue | undefined;
  error: string | undefined;
  onChange: (value: ElicitationFieldValue | undefined) => void;
}) {
  const label = fieldLabel(field);
  const description = fieldDescription(field);
  const fieldId = `trusted-interaction-field-${field.name}`;
  const describedBy = description ? `${fieldId}-description` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const ariaDescribedBy = [describedBy, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5" data-testid={`trusted-interaction-field-${field.name}`}>
      <Label htmlFor={fieldId} className="text-xs font-medium">
        {label}
        {field.required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      <ElicitationApprovalFieldControl
        field={field}
        fieldId={fieldId}
        value={value}
        ariaDescribedBy={ariaDescribedBy}
        invalid={Boolean(error)}
        onChange={onChange}
      />
      {description && (
        <div id={describedBy} className="text-xs text-muted-foreground">
          {description}
        </div>
      )}
      {error && (
        <div id={errorId} className="text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

function ElicitationApprovalFieldControl({
  field,
  fieldId,
  value,
  ariaDescribedBy,
  invalid,
  onChange,
}: {
  field: ElicitationSchemaField;
  fieldId: string;
  value: ElicitationFieldValue | undefined;
  ariaDescribedBy: string | undefined;
  invalid: boolean;
  onChange: (value: ElicitationFieldValue | undefined) => void;
}) {
  const options = enumOptions(field.schema);
  if (options.length > 0) {
    return (
      <NativeSelect
        id={fieldId}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid}
        className="w-full"
      >
        <NativeSelectOption value="">Select...</NativeSelectOption>
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  }

  const multiOptions = multiSelectOptions(field.schema);
  if (multiOptions.length > 0) {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div
        id={fieldId}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid}
        className="space-y-1.5 rounded-md border border-border p-2"
      >
        {multiOptions.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <Label key={option.value} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={checked}
                onCheckedChange={(nextChecked) => {
                  const next = nextChecked === true;
                  onChange(
                    next
                      ? [...selected, option.value]
                      : selected.filter((item) => item !== option.value),
                  );
                }}
              />
              <span>{option.label}</span>
            </Label>
          );
        })}
      </div>
    );
  }

  if (field.schema.type === "boolean") {
    return (
      <Label className="flex items-center gap-2 rounded-md border border-border p-2 text-sm">
        <Checkbox
          id={fieldId}
          checked={value === true}
          onCheckedChange={(nextChecked) => onChange(nextChecked === true)}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid}
        />
        <span>Yes</span>
      </Label>
    );
  }

  if (field.schema.type === "number" || field.schema.type === "integer") {
    return (
      <Input
        id={fieldId}
        type="number"
        value={value === undefined ? "" : String(value)}
        step={field.schema.type === "integer" ? 1 : "any"}
        min={numericConstraint(field.schema, "minimum")}
        max={numericConstraint(field.schema, "maximum")}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid}
      />
    );
  }

  const isLongText = typeof field.schema.maxLength === "number" && field.schema.maxLength > 160;
  if (field.schema.type === "string" && isLongText && field.schema.format === undefined) {
    return (
      <Textarea
        id={fieldId}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid}
        className="min-h-20"
      />
    );
  }

  const inputType =
    field.schema.format === "email" ? "email" : field.schema.format === "uri" ? "url" : "text";
  return (
    <Input
      id={fieldId}
      type={inputType}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
      aria-describedby={ariaDescribedBy}
      aria-invalid={invalid}
    />
  );
}
