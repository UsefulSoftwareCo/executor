import { Array as Arr, Effect, Option, Schema } from "effect";
import {
  isTextFile,
  JsonObject,
  sourceText,
  type SourceFile,
  type SourceFiles,
} from "@executor-js/sdk/core";

const exactVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;

export const compareReleases = (left: string, right: string): number | undefined => {
  const parse = (version: string) => {
    const match = exactVersion.exec(version);
    if (match === null) return undefined;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? [] : match[4].split("."),
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (a === undefined || b === undefined) return undefined;
  for (let index = 0; index < 3; index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  const numeric = /^\d+$/u;
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index] ?? "";
    const y = b.pre[index] ?? "";
    if (x === y) continue;
    if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
    if (numeric.test(x)) return -1;
    if (numeric.test(y)) return 1;
    return x < y ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
};

export const scopedRequirementsRelease = "0.0.1-beta.90";

const Manifest = Schema.fromJsonString(JsonObject);
const Dependencies = Schema.Record(Schema.String, Schema.Unknown);

export const declaredRelease = (files: ReadonlyArray<SourceFile>) => {
  const content = sourceText(files, "package.json");
  if (content === undefined) return undefined;
  const manifest = Schema.decodeUnknownOption(Manifest)(content);
  if (Option.isNone(manifest)) return undefined;
  const dependencies = Schema.decodeUnknownOption(Dependencies)(manifest.value.dependencies);
  if (Option.isNone(dependencies)) return undefined;
  const apps = dependencies.value.apps;
  return typeof apps === "string" && exactVersion.test(apps) ? apps : undefined;
};

export const declaredPackage = (files: ReadonlyArray<SourceFile>) => {
  const content = sourceText(files, "package.json");
  if (content === undefined) return undefined;
  const manifest = Schema.decodeUnknownOption(Manifest)(content);
  if (Option.isNone(manifest)) return undefined;
  const name = manifest.value.name;
  return typeof name === "string" ? name : undefined;
};

const repinnedManifest = (content: string, from: string, to: string) => {
  const escaped = from.replaceAll(".", "\\.").replaceAll("+", "\\+");
  const declaration = new RegExp(`("apps"\\s*:\\s*)"${escaped}"`, "gu");
  if ((content.match(declaration)?.length ?? 0) !== 1) return undefined;
  const replaced = content.replace(declaration, `$1${JSON.stringify(to)}`);
  const before = Schema.decodeUnknownOption(Manifest)(content);
  const after = Schema.decodeUnknownOption(Manifest)(replaced);
  if (Option.isNone(before) || Option.isNone(after)) return undefined;
  const dependencies = Schema.decodeUnknownOption(Dependencies)(before.value.dependencies);
  if (Option.isNone(dependencies)) return undefined;
  const expected = { ...before.value, dependencies: { ...dependencies.value, apps: to } };
  return JSON.stringify(after.value) === JSON.stringify(expected) ? replaced : undefined;
};

export const codeOnly = (text: string): string => {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index++) if (out[index] !== "\n") out[index] = " ";
  };
  const braces: Array<"code" | "template"> = [];
  let index = 0;
  let regexAllowed = true;
  const templateFrom = (start: number) => {
    let cursor = start;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === "\\") {
        cursor += 2;
        continue;
      }
      if (char === "`") {
        blank(start, cursor);
        return { end: cursor + 1, substitution: false };
      }
      if (char === "$" && text[cursor + 1] === "{") {
        blank(start, cursor);
        return { end: cursor + 2, substitution: true };
      }
      cursor++;
    }
    blank(start, cursor);
    return { end: cursor, substitution: false };
  };
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < text.length && text[cursor] !== char && text[cursor] !== "\n")
        cursor += text[cursor] === "\\" ? 2 : 1;
      blank(index + 1, cursor);
      index = cursor + 1;
      regexAllowed = false;
      continue;
    }
    if (char === "`") {
      const read = templateFrom(index + 1);
      if (read.substitution) braces.push("template");
      index = read.end;
      regexAllowed = !read.substitution ? false : true;
      continue;
    }
    if (char === "/" && regexAllowed) {
      let cursor = index + 1;
      let inClass = false;
      while (cursor < text.length && text[cursor] !== "\n") {
        const current = text[cursor];
        if (current === "\\") {
          cursor += 2;
          continue;
        }
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
        cursor++;
      }
      blank(index + 1, cursor);
      index = cursor + 1;
      while (index < text.length && /[a-z]/u.test(text[index]!)) index++;
      regexAllowed = false;
      continue;
    }
    if (char === "{") {
      braces.push("code");
      regexAllowed = true;
      index++;
      continue;
    }
    if (char === "}") {
      const kind = braces.pop();
      if (kind === "template") {
        const read = templateFrom(index + 1);
        if (read.substitution) braces.push("template");
        index = read.end;
        regexAllowed = !read.substitution ? false : true;
        continue;
      }
      regexAllowed = false;
      index++;
      continue;
    }
    if (/[\s]/u.test(char)) {
      index++;
      continue;
    }
    if (/[A-Za-z0-9_$]/u.test(char)) {
      let cursor = index;
      while (cursor < text.length && /[A-Za-z0-9_$]/u.test(text[cursor]!)) cursor++;
      const word = text.slice(index, cursor);
      regexAllowed =
        /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/u.test(
          word,
        );
      index = cursor;
      continue;
    }
    regexAllowed = char !== ")" && char !== "]";
    index++;
  }
  return out.join("");
};

const closing = (code: string, open: number) => {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [];
  for (let index = open; index < code.length; index++) {
    const char = code[index]!;
    if (char in pairs) stack.push(pairs[char]!);
    else if (char === "}" || char === ")" || char === "]") {
      if (stack.pop() !== char) return undefined;
      if (stack.length === 0) return index;
    }
  }
  return undefined;
};

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const skipSpace = (code: string, from: number) => {
  let index = from;
  while (index < code.length && /\s/u.test(code[index]!)) index++;
  return index;
};
const previousNonSpace = (code: string, from: number) => {
  let index = from - 1;
  while (index >= 0 && /\s/u.test(code[index]!)) index--;
  return index;
};

export type ScopedEdit = {
  readonly kind: "declaration" | "binding" | "read";
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

const wordsAt = (code: string, word: string) =>
  [...code.matchAll(new RegExp(`(?<![A-Za-z0-9_$])${word}(?![A-Za-z0-9_$])`, "gu"))].map(
    (match) => match.index,
  );

const onlyProperties = (code: string, word = "accounts") =>
  wordsAt(code, word).every((at) => {
    const previous = code[previousNonSpace(code, at)];
    const following = code[skipSpace(code, at + word.length)];
    return previous === "." || ((previous === "{" || previous === ",") && following === ":");
  });

export const applyEdits = (text: string, edits: ReadonlyArray<ScopedEdit>) => {
  let result = text;
  for (const edit of edits.toSorted((left, right) => right.start - left.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
};

export const scopedIndex = (text: string): string | undefined => {
  const edits = scopedIndexEdits(text);
  return edits === undefined ? undefined : applyEdits(text, edits);
};

export const scopedIndexEdits = (text: string): ReadonlyArray<ScopedEdit> | undefined => {
  const code = codeOnly(text);
  if (!onlyProperties(code, "user")) return undefined;
  const calls = [...code.matchAll(/(?<![A-Za-z0-9_$.])defineApp\s*\(/gu)];
  if (calls.length !== 1) return undefined;
  const call = calls[0]!;
  const callOpen = call.index + call[0].length - 1;
  const callClose = closing(code, callOpen);
  if (callClose === undefined) return undefined;
  const objectOpen = skipSpace(code, callOpen + 1);
  if (code[objectOpen] !== "{") return undefined;
  const objectClose = closing(code, objectOpen);
  if (objectClose === undefined) return undefined;

  const edits: ScopedEdit[] = [];
  const handled = new Set<number>();
  const names: string[] = [];

  const requirement = wordsAt(code, "accounts").filter((at) => at > objectOpen && at < objectClose);
  if (requirement.length !== 1) return undefined;
  const key = requirement[0]!;
  const before = code[previousNonSpace(code, key)];
  if (before !== "{" && before !== ",") return undefined;
  if (closing(code, objectOpen) !== objectClose) return undefined;
  {
    let depth = 0;
    for (let index = objectOpen + 1; index < key; index++) {
      const char = code[index]!;
      if (char === "{" || char === "(" || char === "[") depth++;
      else if (char === "}" || char === ")" || char === "]") depth--;
    }
    if (depth !== 0) return undefined;
  }
  const colon = skipSpace(code, key + "accounts".length);
  if (code[colon] !== ":") return undefined;
  const valueOpen = skipSpace(code, colon + 1);
  if (code[valueOpen] !== "{") return undefined;
  const valueClose = closing(code, valueOpen);
  if (valueClose === undefined) return undefined;
  const entries = code.slice(valueOpen + 1, valueClose).trim();
  if (entries !== "") {
    for (const entry of entries.split(",")) {
      const trimmed = entry.trim();
      if (trimmed === "") continue;
      const match =
        /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\.\s*many\s*\(\s*\)$/u.exec(
          trimmed,
        );
      if (match === null) return undefined;
      names.push(match[1]!);
    }
  }
  edits.push({ kind: "declaration", start: key, end: key, text: "user: { " });
  edits.push({ kind: "declaration", start: valueClose + 1, end: valueClose + 1, text: " }" });
  handled.add(key);

  for (const at of wordsAt(code, "accounts")) {
    if (handled.has(at)) continue;
    const previous = code[previousNonSpace(code, at)];
    const following = code[skipSpace(code, at + "accounts".length)];
    if (previous === "." || ((previous === "{" || previous === ",") && following === ":"))
      handled.add(at);
  }

  const comma = skipSpace(code, objectClose + 1);
  const accounts = wordsAt(code, "accounts").filter((at) => !handled.has(at));
  if (accounts.length > 0) {
    if (code[comma] !== ",") return undefined;
    let start = skipSpace(code, comma + 1);
    if (code.startsWith("async", start) && !/[A-Za-z0-9_$]/u.test(code[start + 5] ?? ""))
      start = skipSpace(code, start + 5);
    if (code[start] !== "(") return undefined;
    const bindingOpen = skipSpace(code, start + 1);
    if (code[bindingOpen] !== "{") return undefined;
    const bindingClose = closing(code, bindingOpen);
    if (bindingClose === undefined) return undefined;
    const binding = accounts.filter((at) => at > bindingOpen && at < bindingClose);
    if (binding.length !== 1) return undefined;
    if (wordsAt(code, "user").some((at) => at > bindingOpen && at < bindingClose)) return undefined;
    const at = binding[0]!;
    const previous = code[previousNonSpace(code, at)];
    const following = code[skipSpace(code, at + "accounts".length)];
    if ((previous !== "{" && previous !== ",") || (following !== "," && following !== "}"))
      return undefined;
    edits.push({ kind: "binding", start: at, end: at + "accounts".length, text: "user" });
    handled.add(at);
    for (const use of accounts) {
      if (handled.has(use)) continue;
      if (use < bindingClose || use > callClose) return undefined;
      if (/[A-Za-z0-9_$.]/u.test(code[use - 1] ?? "")) return undefined;
      const dot = use + "accounts".length;
      if (code[dot] !== ".") return undefined;
      let end = dot + 1;
      while (end < code.length && /[A-Za-z0-9_$]/u.test(code[end]!)) end++;
      const name = code.slice(dot + 1, end);
      if (!identifier.test(name) || !names.includes(name)) return undefined;
      const after = code[skipSpace(code, end)];
      if (after !== "," && after !== ")") return undefined;
      edits.push({ kind: "read", start: use, end, text: `user?.accounts.${name} ?? []` });
      handled.add(use);
    }
  }
  if (wordsAt(code, "accounts").some((at) => !handled.has(at))) return undefined;
  return edits;
};

export const upgradedFiles = (files: SourceFiles, to: string): SourceFiles | undefined => {
  const from = declaredRelease(files);
  if (from === undefined) return undefined;
  const manifest = repinnedManifest(sourceText(files, "package.json") ?? "", from, to);
  if (manifest === undefined) return undefined;
  const order = compareReleases(from, scopedRequirementsRelease);
  if (order === undefined) return undefined;
  let index: string | undefined;
  if (order < 0) {
    const current = sourceText(files, "index.ts");
    if (current === undefined) return undefined;
    index = scopedIndex(current);
    if (index === undefined) return undefined;
    for (const file of files) {
      if (file.path === "index.ts" || !/\.(?:[cm]?[jt]sx?)$/u.test(file.path)) continue;
      if (!isTextFile(file) || !onlyProperties(codeOnly(file.content))) return undefined;
    }
  }
  const scoped = index;
  return Arr.map(files, (file): SourceFile =>
    file.path === "package.json"
      ? { path: file.path, content: manifest }
      : file.path === "index.ts" && scoped !== undefined
        ? { path: file.path, content: scoped }
        : file,
  );
};

const fileIdentity = (file: SourceFile) =>
  "object" in file
    ? `object:${file.object}`
    : "encoding" in file
      ? `base64:${file.content}`
      : `text:${file.content}`;

export const sourceDigest = (files: ReadonlyArray<SourceFile>) =>
  Effect.promise(async () => {
    const ordered = files
      .map((file) => [file.path, fileIdentity(file)] as const)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const bytes = new TextEncoder().encode(JSON.stringify(ordered));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 8);
    let binary = "";
    for (const byte of hash) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  });
