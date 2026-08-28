import { ConnectionName } from "./ids";

export const isConnectionIdentifier = (value: string): boolean =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);

export const connectionIdentifier = (input: string, fallback = "connection"): ConnectionName => {
  // Skip retokenizing names already in the tokenizer's output shape so the
  // transform is idempotent.
  if (/^[a-z][A-Za-z0-9]*$/.test(input)) return ConnectionName.make(input);

  const words = input.toLowerCase().match(/[a-z0-9]+/g);
  const base =
    words
      ?.map((word, index) =>
        index === 0 ? word : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`,
      )
      .join("") || fallback;

  return ConnectionName.make(
    /^[A-Za-z_$]/.test(base) ? base : `${fallback}${base[0]?.toUpperCase() ?? ""}${base.slice(1)}`,
  );
};
