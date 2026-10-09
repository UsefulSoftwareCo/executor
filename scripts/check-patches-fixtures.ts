/**
 * Setups check-patches.ts must reject (`applied: false`) or accept, for a package `fixture` whose
 * selector is `fixture@1.0.0` unless the fixture names another. `installed` maps Bun store entries
 * (`fixture@1.0.0`, `fixture@1.0.0_peer` for a second copy) to the files of that copy.
 */
export type Fixture = {
  readonly name: string;
  readonly applied: boolean;
  readonly patch: string;
  readonly installed: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly selector?: string;
};

const text = (...lines: ReadonlyArray<string>) => lines.map((line) => `${line}\n`).join("");

const original = text("a", "b", "c", "d", "e", "f", "g");
const patched = text("a", "b", "c", "D", "e", "f", "g");
/** Changes `d` to `D` in `path`. */
const change = (path: string) =>
  text(
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,7 +1,7 @@",
    " a",
    " b",
    " c",
    "-d",
    "+D",
    " e",
    " f",
    " g",
  );
const rename = text(
  "diff --git a/old.js b/new.js",
  "similarity index 100%",
  "rename from old.js",
  "rename to new.js",
);
const renameAndChange = text(
  "diff --git a/old.js b/new.js",
  "similarity index 85%",
  "rename from old.js",
  "rename to new.js",
  "--- a/old.js",
  "+++ b/new.js",
  "@@ -1,7 +1,7 @@",
  " a",
  " b",
  " c",
  "-d",
  "+D",
  " e",
  " f",
  " g",
);
const keepDrop = text("--- a/index.js", "+++ b/index.js", "@@ -1,2 +1 @@", " keep", "-drop");
const deleteAll = text("--- a/index.js", "+++ b/index.js", "@@ -1,2 +0,0 @@", "-a", "-b");
const createAndDelete = text(
  "diff --git a/added.js b/added.js",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/added.js",
  "@@ -0,0 +1 @@",
  "+added",
  "diff --git a/removed.js b/removed.js",
  "deleted file mode 100644",
  "--- a/removed.js",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-removed",
);
/** A file whose line 9 onwards repeats lines 1 to 7: the block a hunk at line 9 changes. */
const twice = (first: string, second: string) => `${first}x\n${second}`;
const changeAtNine = text(
  "--- a/index.js",
  "+++ b/index.js",
  "@@ -9,7 +9,7 @@",
  " a",
  " b",
  " c",
  "-d",
  "+D",
  " e",
  " f",
  " g",
);

export const fixtures: ReadonlyArray<Fixture> = [
  {
    name: "changed hunk applied",
    applied: true,
    patch: change("index.js"),
    installed: { "fixture@1.0.0": { "index.js": patched } },
  },
  {
    name: "changed hunk reverted",
    applied: false,
    patch: change("index.js"),
    installed: { "fixture@1.0.0": { "index.js": original } },
  },
  {
    name: "stale selector",
    applied: false,
    selector: "fixture@1.0.1",
    patch: change("index.js"),
    installed: { "fixture@1.0.0": { "index.js": patched } },
  },
  {
    name: "second installed copy unpatched",
    applied: false,
    patch: change("index.js"),
    installed: {
      "fixture@1.0.0": { "index.js": patched },
      "fixture@1.0.0_peer": { "index.js": original },
    },
  },
  {
    name: "src applied, dist reverted",
    applied: false,
    patch: change("src.js") + change("dist.js"),
    installed: { "fixture@1.0.0": { "src.js": patched, "dist.js": original } },
  },
  {
    name: "context and deletion applied",
    applied: true,
    patch: keepDrop,
    installed: { "fixture@1.0.0": { "index.js": text("keep") } },
  },
  {
    name: "context and deletion, not applied",
    applied: false,
    patch: keepDrop,
    installed: { "fixture@1.0.0": { "index.js": text("keep", "drop") } },
  },
  {
    name: "context-free deletion applied",
    applied: true,
    patch: deleteAll,
    installed: { "fixture@1.0.0": { "index.js": "" } },
  },
  {
    name: "context-free deletion, not applied",
    applied: false,
    patch: deleteAll,
    installed: { "fixture@1.0.0": { "index.js": text("a", "b") } },
  },
  {
    name: "context-free deletion, partly applied",
    applied: false,
    patch: deleteAll,
    installed: { "fixture@1.0.0": { "index.js": text("b") } },
  },
  {
    name: "context-free deletion, old text moved",
    applied: false,
    patch: deleteAll,
    installed: { "fixture@1.0.0": { "index.js": text("b", "a") } },
  },
  {
    name: "pure rename applied",
    applied: true,
    patch: change("index.js") + rename,
    installed: { "fixture@1.0.0": { "index.js": patched, "new.js": original } },
  },
  {
    name: "valid hunk plus unapplied pure rename",
    applied: false,
    patch: change("index.js") + rename,
    installed: { "fixture@1.0.0": { "index.js": patched, "old.js": original } },
  },
  {
    name: "rename with hunk applied",
    applied: true,
    patch: renameAndChange,
    installed: { "fixture@1.0.0": { "new.js": patched } },
  },
  {
    name: "rename with hunk leaves the original",
    applied: false,
    patch: renameAndChange,
    installed: { "fixture@1.0.0": { "new.js": patched, "old.js": original } },
  },
  {
    name: "file created and file deleted",
    applied: true,
    patch: createAndDelete,
    installed: { "fixture@1.0.0": { "added.js": text("added") } },
  },
  {
    name: "created file missing",
    applied: false,
    patch: createAndDelete,
    installed: { "fixture@1.0.0": {} },
  },
  {
    name: "deleted file remains",
    applied: false,
    patch: createAndDelete,
    installed: { "fixture@1.0.0": { "added.js": text("added"), "removed.js": text("removed") } },
  },
  {
    name: "header with no hunks",
    applied: false,
    patch: change("index.js") + text("--- a/other.js", "+++ b/other.js"),
    installed: { "fixture@1.0.0": { "index.js": patched, "other.js": original } },
  },
  {
    // Git skips the second section and applies the first, which names the same file.
    name: "header with no hunks borrowing another section's file",
    applied: false,
    patch: change("index.js") + text("--- a/old.js", "+++ b/index.js"),
    installed: { "fixture@1.0.0": { "index.js": patched, "old.js": original } },
  },
  {
    name: "header with no hunks before a section for the same file",
    applied: false,
    patch: text("--- a/old.js", "+++ b/index.js") + change("index.js"),
    installed: { "fixture@1.0.0": { "index.js": patched, "old.js": original } },
  },
  {
    // Removes `-- a/x` and adds `++ b/x`: hunk lines, not a section header.
    name: "hunk lines that look like a header",
    applied: true,
    patch: text(
      "--- a/index.js",
      "+++ b/index.js",
      "@@ -1,2 +1,2 @@",
      " keep",
      "--- a/x",
      "+++ b/x",
    ),
    installed: { "fixture@1.0.0": { "index.js": text("keep", "++ b/x") } },
  },
  {
    name: "CRLF patch applied",
    applied: true,
    patch: change("index.js").replaceAll("\n", "\r\n"),
    installed: { "fixture@1.0.0": { "index.js": patched.replaceAll("\n", "\r\n") } },
  },
  {
    name: "file mode matches the patch",
    applied: true,
    patch:
      text("diff --git a/index.js b/index.js", "index 1111111..2222222 100644") +
      change("index.js"),
    installed: { "fixture@1.0.0": { "index.js": patched } },
  },
  {
    // Git warns that the installed file is not executable, and succeeds.
    name: "file mode differs from the patch",
    applied: false,
    patch:
      text("diff --git a/index.js b/index.js", "index 1111111..2222222 100755") +
      change("index.js"),
    installed: { "fixture@1.0.0": { "index.js": patched } },
  },
  {
    name: "git header with no hunks",
    applied: false,
    patch:
      text("diff --git a/other.js b/other.js", "index 1111111..2222222 100644") +
      text("diff --git a/index.js b/index.js") +
      change("index.js"),
    installed: { "fixture@1.0.0": { "index.js": patched, "other.js": original } },
  },
  {
    name: "hunk that changes nothing",
    applied: false,
    patch: text("--- a/index.js", "+++ b/index.js", "@@ -1,3 +1,3 @@", " a", "-b", "+b", " c"),
    installed: { "fixture@1.0.0": { "index.js": original } },
  },
  {
    name: "mode change",
    applied: false,
    patch: text("diff --git a/index.js b/index.js", "old mode 100644", "new mode 100755"),
    installed: { "fixture@1.0.0": { "index.js": original } },
  },
  {
    name: "binary change",
    applied: false,
    patch: text(
      "diff --git a/image.png b/image.png",
      "index 1111111..2222222 100644",
      "Binary files a/image.png and b/image.png differ",
    ),
    installed: { "fixture@1.0.0": { "image.png": "png" } },
  },
  {
    // The unpatched block also appears before the patched one, so the patch applies forward too,
    // but only at an offset.
    name: "patched block repeats an unpatched one",
    applied: true,
    patch: changeAtNine,
    installed: { "fixture@1.0.0": { "index.js": twice(original, patched) } },
  },
  {
    // The hunk's result is in the file, but not at the line its header names.
    name: "patched block only at another line",
    applied: false,
    patch: changeAtNine,
    installed: { "fixture@1.0.0": { "index.js": twice(patched, original) } },
  },
];
