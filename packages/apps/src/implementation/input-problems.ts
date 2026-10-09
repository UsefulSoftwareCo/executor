import { Match, Schema, SchemaAST, SchemaIssue } from "effect";
import { HostInputInvalid, maxInputProblems } from "../contracts/host.ts";
import {
  allowedValues,
  echoableKey,
  maxAlternativeKeys,
  missingKey,
  importedSchemaKeys,
  missingKeyText,
  objectShape,
  unionShape,
} from "./schema.ts";

/** A native object by its declared keys, as imported JSON Schema objects are described. */
const nativeObjectShape = (ast: SchemaAST.Objects, limit?: number) =>
  objectShape(
    ast.propertySignatures.flatMap(({ name, type }) =>
      typeof name === "string"
        ? [{ name, optional: SchemaAST.isOptional(SchemaAST.toEncoded(type)) }]
        : [],
    ),
    ast.indexSignatures.length > 0,
    limit,
  );

/** The members of a union that JSON input can match. `undefined` only marks an optional key. */
const unionMembers = (ast: SchemaAST.AST): readonly SchemaAST.AST[] =>
  SchemaAST.isUnion(ast)
    ? ast.types.flatMap(unionMembers)
    : SchemaAST.isUndefined(ast) || SchemaAST.isVoid(ast)
      ? []
      : [ast];

/** The values a schema of literals and enums allows; undefined when it accepts other values. */
const fixedValues = (ast: SchemaAST.AST): readonly unknown[] | undefined => {
  if (SchemaAST.isLiteral(ast)) return [ast.literal];
  if (SchemaAST.isEnum(ast)) return ast.enums.map(([, value]) => value);
  if (!SchemaAST.isUnion(ast)) return undefined;
  const members = unionMembers(ast).map(fixedValues);
  return members.length > 0 &&
    members.every((values): values is readonly unknown[] => values !== undefined)
    ? members.flat()
    : undefined;
};

/** A union member by its type and object keys, as JSON Schema alternatives are described. */
const describeMember = (ast: SchemaAST.AST): string =>
  Match.value(ast).pipe(
    Match.when(SchemaAST.isObjects, (objects) =>
      objects.propertySignatures.length > 0
        ? nativeObjectShape(objects, maxAlternativeKeys)
        : "object",
    ),
    Match.when(SchemaAST.isArrays, () => "array"),
    Match.when(SchemaAST.isTemplateLiteral, () => "a string matching a template"),
    Match.when(SchemaAST.isString, () => "string"),
    Match.when(SchemaAST.isNumber, () => "number"),
    Match.when(SchemaAST.isBoolean, () => "boolean"),
    Match.when(SchemaAST.isNull, () => "null"),
    Match.orElse(() => "a value with other constraints"),
  );

/** The key every object member fixes to its own value, such as an account router's account. */
const memberSelector = (members: readonly SchemaAST.AST[]) => {
  const [first] = members;
  if (members.length < 2 || first === undefined || !SchemaAST.isObjects(first)) return undefined;
  return first.propertySignatures
    .map(({ name }) => name)
    .find(
      (name): name is string =>
        typeof name === "string" &&
        members.every(
          (member) =>
            SchemaAST.isObjects(member) &&
            member.propertySignatures.some(
              (property) =>
                property.name === name &&
                fixedValues(SchemaAST.toEncoded(property.type)) !== undefined,
            ),
        ),
    );
};

/**
 * A union that no member applied to, by the values its literal members allow and its other
 * members' shapes. The native message lists literals without a bound and describes objects by
 * their types rather than their keys.
 */
const unionExpectation = (ast: SchemaAST.Union) => {
  const members = unionMembers(ast);
  const fixed = members.map(fixedValues);
  const values = fixed.flatMap((memberValues) => (memberValues === undefined ? [] : memberValues));
  const others = members.filter((_, index) => fixed[index] === undefined);
  if (others.length === 0) return allowedValues(values);
  return unionShape(
    [
      ...(values.length === 0 ? [] : [allowedValues(values)]),
      ...new Set(others.map(describeMember)),
    ],
    memberSelector(members),
  );
};
const expectedUnion = (ast: SchemaAST.Union) => `Expected ${unionExpectation(ast)}`;

/**
 * What a declared key expects, as a missing key's problem states it. Undefined when its schema
 * is described by neither values, a type nor keys, such as an imported JSON Schema.
 */
const expectedValue = (ast: SchemaAST.AST): string | undefined => {
  const encoded = SchemaAST.toEncoded(ast);
  const values = fixedValues(encoded);
  if (values !== undefined) return allowedValues(values);
  const members = unionMembers(encoded);
  const [only] = members;
  if (only === undefined) return undefined;
  if (members.length > 1 && SchemaAST.isUnion(encoded)) return unionExpectation(encoded);
  if (SchemaAST.isObjects(only) && only.propertySignatures.length > 0)
    return nativeObjectShape(only);
  const described = describeMember(only);
  return described === "a value with other constraints" ? undefined : described;
};

// Reported input only exists when a parser opts in; never render it either way.
const leafHook: SchemaIssue.LeafHook = (issue) =>
  SchemaIssue.hasInput(issue)
    ? "Invalid value"
    : Match.value(issue).pipe(
        Match.tag("InvalidType", ({ ast }) => {
          const values = fixedValues(ast);
          return values !== undefined
            ? `Expected ${allowedValues(values)}`
            : SchemaAST.isObjects(ast) && ast.propertySignatures.length > 0
              ? `Expected ${nativeObjectShape(ast)}`
              : SchemaIssue.defaultLeafHook(issue);
        }),
        Match.orElse(SchemaIssue.defaultLeafHook),
      );
const checkHook: SchemaIssue.CheckHook = (issue) =>
  SchemaIssue.hasInput(issue) || SchemaIssue.hasInput(issue.issue)
    ? (SchemaIssue.defaultCheckHook(issue) ?? "Invalid value")
    : SchemaIssue.defaultCheckHook(issue);
const format = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook, checkHook });

interface Located {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  /**
   * For a missing key, whether the schema of the object that misses it may accept a key as its
   * own. Undefined when that schema is not known, and no other place in the input is suggested.
   */
  readonly accepts?: (key: string) => boolean;
}

/** The schema an object declares for one key, when `parent` is an object that declares it. */
const declaredKey = (parent: SchemaAST.AST | undefined, key: PropertyKey | undefined) =>
  parent !== undefined && SchemaAST.isObjects(parent)
    ? parent.propertySignatures.find(({ name }) => name === key)?.type
    : undefined;

/** Whether an object schema may accept a key as its own: it declares it or has a record's keys. */
const nativeKeys = (parent: SchemaAST.Objects) => (key: string) =>
  parent.indexSignatures.length > 0 || parent.propertySignatures.some(({ name }) => name === key);

/**
 * Problems by path, as the Standard Schema formatter flattens them, except that a union no member
 * applied to is described by {@link expectedUnion} and a missing key states what it expects.
 * `parent` is the schema of the object whose issues are being located.
 */
const located = (
  issue: SchemaIssue.Issue,
  path: readonly PropertyKey[],
  parent?: SchemaAST.AST,
): readonly Located[] =>
  Match.value(issue).pipe(
    Match.tag("Pointer", (pointer) => {
      const declared =
        pointer.issue._tag === "MissingKey" && pointer.path.length === 1
          ? declaredKey(parent, pointer.path[0])
          : undefined;
      return declared === undefined || parent === undefined || !SchemaAST.isObjects(parent)
        ? located(pointer.issue, [...path, ...pointer.path])
        : [
            {
              path: [...path, ...pointer.path],
              message: missingKey(expectedValue(declared)),
              accepts: nativeKeys(parent),
            },
          ];
    }),
    Match.tag("Composite", ({ ast, issues }) =>
      issues.flatMap((issue) => located(issue, path, ast)),
    ),
    Match.tag("Encoding", (encoding) => located(encoding.issue, path)),
    Match.tag("AnyOf", ({ ast, issues }) =>
      issues.length === 0
        ? [{ path, message: expectedUnion(ast) }]
        : issues.flatMap((issue) => located(issue, path)),
    ),
    Match.orElse((issue) => {
      // An imported schema's problems come from its check, which knows the keys it may accept.
      const accepts = issue._tag === "Filter" ? importedSchemaKeys(issue.filter) : undefined;
      return format(issue).issues.map((problem) => ({
        path: [
          ...path,
          ...(problem.path ?? []).map((key) => (typeof key === "object" ? key.key : key)),
        ],
        message: problem.message,
        ...(accepts === undefined ? {} : { accepts }),
      }));
    }),
  );

// Field names and indexes locate the problem; keys that could carry supplied data are not echoed.
const segment = (key: PropertyKey) =>
  typeof key === "number"
    ? `[${key}]`
    : typeof key === "string" && echoableKey(key)
      ? `.${key}`
      : "[key]";

const rendered = (path: readonly PropertyKey[]) => `input${path.map(segment).join("")}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The supplied value at a path, when every segment names an own key or an array index. */
const valueAt = (input: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      Array.isArray(value) && typeof key === "number"
        ? value[key]
        : isRecord(value) && typeof key === "string" && Object.hasOwn(value, key)
          ? value[key]
          : undefined,
    input,
  );

/** Spellings agents mix up for one key: `policy_id`, `policyId` and `PolicyID`. */
const spelling = (key: string) => key.toLowerCase().replace(/[-_]/g, "");

/**
 * Where the supplied input may have a key its schema requires elsewhere: under another spelling in
 * the same object, or nested one object too deep. Agents most often miss a key that way, and the
 * problem can ask about the place it may have come from. A key the object's schema may accept,
 * per `accepts`, is legitimately where it is, and neither it nor its value is suggested: in a
 * recursive schema a declared child holds the same key. An enclosing object is not searched for
 * the same reason. Names a supplied key only when it is a plain identifier, and never a value.
 */
const suppliedElsewhere = (
  input: unknown,
  path: readonly PropertyKey[],
  accepts: (key: string) => boolean,
): string | undefined => {
  const key = path.at(-1);
  if (typeof key !== "string" || !echoableKey(key)) return undefined;
  const at = path.slice(0, -1);
  const holder = valueAt(input, at);
  if (!isRecord(holder)) return undefined;
  const candidates = Object.keys(holder).filter((name) => echoableKey(name) && !accepts(name));
  const respelled = candidates.find((name) => name !== key && spelling(name) === spelling(key));
  const deeper = candidates.find((name) => {
    const child = holder[name];
    return isRecord(child) && Object.hasOwn(child, key);
  });
  const found =
    respelled !== undefined
      ? [...at, respelled]
      : deeper !== undefined
        ? [...at, deeper, key]
        : undefined;
  return found === undefined
    ? undefined
    : `The input has ${String(found.at(-1))} at ${rendered(found)}; did you mean ${rendered(path)}?`;
};

/**
 * Failing input paths and what each expects, from a schema decode failure, without supplied
 * values. An expected object names its keys, so a caller can correct nesting from the problem.
 * A missing key also asks about a place where `input`, the rejected input, may have that key.
 */
export const inputInvalid = (error: unknown, input: unknown): HostInputInvalid => {
  if (!Schema.isSchemaError(error)) return new HostInputInvalid();
  const problems = located(error.issue, [])
    .slice(0, maxInputProblems)
    .map(({ path, message, accepts }) => {
      const elsewhere =
        accepts !== undefined && message.startsWith(missingKeyText)
          ? suppliedElsewhere(input, path, accepts)
          : undefined;
      return `${rendered(path)}: ${message}${elsewhere === undefined ? "" : `. ${elsewhere}`}`.slice(
        0,
        512,
      );
    });
  return new HostInputInvalid({ problems });
};
