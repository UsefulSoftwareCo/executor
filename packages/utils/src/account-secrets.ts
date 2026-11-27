import { Predicate } from "effect";

const minimumSecretLength = 6;

const secretValues = (
  value: unknown,
  found: Set<string>,
  minimum = minimumSecretLength,
): Set<string> => {
  if (typeof value === "string") {
    if (value.length >= minimum) found.add(value);
  } else if (Array.isArray(value)) for (const item of value) secretValues(item, found, minimum);
  else if (Predicate.isObject(value))
    for (const item of Object.values(value)) secretValues(item, found, minimum);
  return found;
};

export const accountFieldSecrets = (accounts: unknown, minimum = minimumSecretLength) => {
  const found = new Set<string>();
  if (Predicate.isObject(accounts))
    for (const scope of [accounts["app"], accounts["user"]])
      if (Predicate.isObject(scope))
        for (const slot of Object.values(scope))
          for (const account of Array.isArray(slot) ? slot : [slot])
            if (Predicate.hasProperty(account, "fields"))
              secretValues(account.fields, found, minimum);
  return [...found].sort((a, b) => b.length - a.length);
};
