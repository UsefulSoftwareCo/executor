/**
 * The publishing run of `.github/workflows/release-artifacts.yml` writes a release's public notes
 * with `scripts/releases/release-notes.ts`. These cases run it as that job does, in a scratch
 * repository laid out as main, against a scratch public repository whose `executor@<version>` tags
 * are `Export <sha>` commits, as scripts/export-public.sh makes them, and read its notes.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash } from "node:crypto";
import {
  acceptedNotes,
  git,
  hexWordNotes,
  type Merge,
  notes,
  portMarker,
  portTrailers,
  realisticNotes,
  refusedNotes,
  repositories,
} from "../release-notes-repositories.ts";

/**
 * What merged after beta.4: one of each kind of change the notes list or leave out. Every note is
 * worded unlike its title, so a title found in the output is a title leaked.
 */
const merges: ReadonlyArray<Merge> = [
  // Two changes with no line first: a release up to them has no notes written.
  { title: "Fix Globex's webhook retries (#118)", files: ["packages/sdk/src/webhooks.ts"] },
  {
    title: "Test the rollback (#104)",
    files: ["e2e/tests/rollback.spec.ts", "apps/cli/src/upgrade-hook.ts"],
  },
  {
    title: "Show app accounts on the Apps cards (#101)",
    body: "Release-note: Each app's card now shows its accounts.",
    files: ["packages/sdk/src/accounts.ts"],
  },
  {
    title: "Add executor upgrade --rollback (#102)",
    body: "Release-note: The upgrade command takes --rollback to go back to the version you had before.",
    files: ["apps/cli/src/upgrade.ts"],
  },
  {
    title: "Fix self-host 502s behind a proxy (#103)",
    body: "Release-note: A self-hosted Executor behind a proxy no longer answers 502.",
    files: ["apps/hosted/self-host/src/proxy.ts"],
  },
  {
    // A moved and changed file, which rename detection would read the contents of. No line.
    title: "Split the self-host proxy (#116)",
    moves: [["apps/hosted/self-host/src/proxy.ts", "apps/hosted/self-host/src/proxy-server.ts"]],
    files: [],
  },
  {
    // A line on a change to nothing a release ships.
    title: "Bill Cloud workspaces by the hour (#117)",
    body: "Release-note: Cloud workspaces are billed by the hour.",
    files: ["apps/hosted/cloud/src/billing.ts"],
  },
  { title: "Run CI on 8 vCPU runners (#105)", files: [".github/workflows/ci.yml"] },
  { title: "Add a deploy fixture (#106)", files: ["packages/sdk/scripts/deploy-fixture.ts"] },
  { title: "Explain the SDK (#107)", files: ["packages/sdk/README.md"] },
  {
    title: "Pin the tsgo version (#108)",
    // HTML and a fenced block can hide a line from whoever reads the message rendered, so a
    // message that holds either has no notes at all.
    body: [
      "Release-note: Keep @effect/tsgo pinned, and #2200's <b>fix</b> with `@scope/kept` (#108)",
      "",
      "```text",
      "Release-note: An earlier draft of this note",
      "```",
    ].join("\n"),
    files: ["packages/sdk/src/pin.ts"],
  },
  {
    title: "Fix Acme Corp's sign-in (#109)",
    body: "Release-note: Fix a sign-in failure with some identity providers",
    files: ["packages/sdk/src/sign-in.ts"],
  },
  {
    title: "Fix the bug Jane reported (#110)",
    body: "Release-note: none",
    files: ["packages/sdk/src/report.ts"],
  },
  {
    title: "Copy the guide over (#111)",
    body: "Release-note: Copy the guide from executor-next",
    files: ["packages/sdk/src/guide.ts"],
  },
  {
    title: "Rate-limit each self-host client behind trusted proxies (#112)",
    body: `Release-note: A self-hosted Executor limits each client behind trusted proxies on its own.\n\n${portMarker}\n\n${portTrailers}`,
    files: ["apps/hosted/self-host/src/limit.ts"],
  },
  {
    title: "Test and document self-host trusted proxies (#113)",
    body: `${portMarker}\n\n${portTrailers}`,
    files: ["e2e/tests/trusted-proxies.spec.ts", "apps/hosted/self-host/README.md"],
  },
  {
    title: "Remove the old banner (#114)",
    body: "Release-note: The old banner is gone.",
    files: ["packages/ui/src/banner.ts"],
  },
  { title: 'Revert "Remove the old banner (#114)" (#115)', files: ["packages/ui/src/banner.ts"] },
  { title: "Release 2.0.0-beta.5 [skip ci]", files: ["apps/cli/package.json"] },
];

/**
 * Lines that look like notes but are examples, and messages that could hide a line from whoever
 * reads them rendered. Each word in capitals, and each "Private" sentence, must never be listed.
 */
const examples: ReadonlyArray<Merge> = [
  {
    title: "Document the note format (#201)",
    body: [
      "Release-note: Notes list each line of a change.",
      "Release-note: A second line of the same change is listed too.",
      "Release-note: Notes list each line of a change.",
      "Release-note: none",
      "",
      "For example:",
      "",
      "    Release-note: INDENTED",
      "",
      "> Release-note: QUOTED",
      "",
      "Write it as Release-note: INLINE on a line of its own.",
    ].join("\n"),
    files: ["packages/sdk/src/format.ts"],
  },
  {
    // A revert of a change released before, quoting the reverted message.
    title: 'Revert "Start (#1)" (#207)',
    body: "This reverts commit 0123456.\n\n> Start (#1)\n>\n> Release-note: REVERTED",
    files: ["apps/cli/src/main.ts"],
  },
];

/**
 * Messages that hold a character which can hide a line when GitHub renders them, each with what it
 * holds. None has a note, though each line would be one in a message without it. The first three
 * are the hidden notes three reviews found published, as they gave them.
 */
const hidden: ReadonlyArray<{ readonly merge: Merge; readonly holds: string }> = [
  {
    // A comment closed and opened again on one line.
    merge: {
      title: "Probe",
      body: "<!--\n--> <!--\nRelease-note: PRIVATE_COMMENT_REOPEN\n-->",
      files: ["packages/sdk/src/reopen.ts"],
    },
    holds: "<",
  },
  {
    // A closing tag in a quoted attribute value.
    merge: {
      title: "Probe",
      body: '<details title="</details>">\nRelease-note: Private attribute details text.\n</details>',
      files: ["packages/sdk/src/attribute.ts"],
    },
    holds: "<",
  },
  {
    // A comment opened on the title line: the whole message is "<!--\n\nRelease-note: ...\n-->".
    merge: {
      title: "<!--",
      body: "Release-note: Private title comment text.\n-->",
      files: ["packages/sdk/src/title.ts"],
    },
    holds: "<",
  },
  {
    // "<" in the title only.
    merge: {
      title: "Accept <none> as a value (#211)",
      body: "Release-note: Private title angle text.",
      files: ["packages/sdk/src/angle.ts"],
    },
    holds: "<",
  },
  {
    merge: {
      title: "Show an example note (#209)",
      body: "<details open>\n<summary>Example</summary>\n\nRelease-note: DETAILS_EXAMPLE\n</details>",
      files: ["packages/sdk/src/example.ts"],
    },
    holds: "<",
  },
  {
    // Only an address written `<name@host>` is allowed `<`; one that starts `<!--` is not.
    merge: {
      title: "Credit a reviewer (#216)",
      body: "Release-note: Private trailer comment text.\n\nCo-authored-by: Someone <!--@example.invalid>\n-->",
      files: ["packages/sdk/src/trailer.ts"],
    },
    holds: "<",
  },
  {
    // A link definition's title spans lines, and GitHub renders the definition as nothing.
    merge: {
      title: "Define a link (#212)",
      body: '[a]: https://example.invalid "\nRelease-note: Private link title text.\n"',
      files: ["packages/sdk/src/link.ts"],
    },
    holds: "[",
  },
  {
    // Only a name ending `[bot]` in a trailer is a trailer's: a definition of `[bot]` starts a line.
    merge: {
      title: "Define a bot link (#217)",
      body: '[bot]: https://example.invalid "\nRelease-note: Private bot link text.\n"\n\nCo-authored-by: helper[bot] <1+helper[bot]@users.noreply.github.com>',
      files: ["packages/sdk/src/bot-link.ts"],
    },
    holds: "[",
  },
  {
    // An address is allowed only in a Co-authored-by trailer, not in the body's prose.
    merge: {
      title: "Thank a reviewer (#218)",
      body: "Release-note: Private body address text.\n\nThanks to Someone <someone@example.invalid> for the review.",
      files: ["packages/sdk/src/body-address.ts"],
    },
    holds: "<",
  },
  {
    // A line that only starts like a trailer: text after the address.
    merge: {
      title: "Credit a reviewer and more (#219)",
      body: "Release-note: Private text after the address.\n\nCo-authored-by: Someone <someone@example.invalid> and friends\n\nThe rest of the message comes after it.",
      files: ["packages/sdk/src/after-address.ts"],
    },
    holds: "<",
  },
  {
    // Two addresses on one trailer line.
    merge: {
      title: "Credit two addresses (#220)",
      body: "Release-note: Private two address text.\n\nCo-authored-by: Someone <someone@example.invalid> <other@example.invalid>\n\nThe rest of the message comes after it.",
      files: ["packages/sdk/src/two-addresses.ts"],
    },
    holds: "<",
  },
  {
    // A comment that starts like an address, in the middle of the message.
    merge: {
      title: "Credit a hidden reviewer (#224)",
      body: "Co-authored-by: x <!--@y>\nRelease-note: Private middle comment text.\n-->\n\nThe rest of the message comes after it.",
      files: ["packages/sdk/src/middle-comment.ts"],
    },
    holds: "<",
  },
  {
    // A name that starts like a quote.
    merge: {
      title: "Credit a quoted reviewer (#225)",
      body: "Release-note: Private quoted name text.\n\nCo-authored-by: > Someone <someone@example.invalid>",
      files: ["packages/sdk/src/quoted-name.ts"],
    },
    holds: "<",
  },
  {
    // A bot's name is allowed `[bot]` only in a trailer, not in the body's prose.
    merge: {
      title: "Credit a bot in prose (#221)",
      body: "Release-note: Private bot prose text.\n\nWritten with helper[bot] and its friends.",
      files: ["packages/sdk/src/bot-prose.ts"],
    },
    holds: "[",
  },
  {
    // Math that draws nothing.
    merge: {
      title: "Add a formula (#213)",
      body: "$$\n\\phantom{\nRelease-note: Private math text.\n}\n$$",
      files: ["packages/sdk/src/math.ts"],
    },
    holds: "$",
  },
  {
    // A note outside the fence is not counted either: the message holds a fence.
    merge: {
      title: "Show a fenced example (#214)",
      body: "Release-note: Private beside a fence.\n\n```text\nRelease-note: FENCED\n```",
      files: ["packages/sdk/src/fenced.ts"],
    },
    holds: "```",
  },
  {
    merge: {
      title: "Show a tilde example (#215)",
      body: "~~~\nRelease-note: TILDES\n~~~",
      files: ["packages/sdk/src/tildes.ts"],
    },
    holds: "~~~",
  },
];

/**
 * Messages whose only `<` and `[` are on lines that are whole Co-authored-by trailers: in the block
 * that ends them, as GitHub squashes, after a `---------` line, with a note among the trailers, and
 * in the middle of a message, as a port's own trailers sit once a squash joins its commits.
 */
const trailered: ReadonlyArray<Merge> = [
  {
    title: "Squash with co-authors (#222)",
    body: [
      "Release-note: Co-authors in the trailer block leave a note listed.",
      "",
      "---------",
      "",
      "Co-authored-by: Someone <someone@example.invalid>",
      "Co-Authored-By: helper[bot] <1+helper[bot]@users.noreply.github.com>",
    ].join("\n"),
    files: ["packages/sdk/src/squash.ts"],
  },
  {
    title: "Write the note among the trailers (#223)",
    body: [
      "Some prose about the change.",
      "",
      "Release-note: A note among the trailers is listed too.",
      "Co-authored-by: Someone Else <someone.else+review@example.invalid>",
    ].join("\n"),
    files: ["packages/sdk/src/among.ts"],
  },
  {
    title: "Squash a port's commits (#219)",
    body: [
      "* Port the contributor's change",
      "",
      "Release-note: A trailer in the middle of a message leaves a note listed.",
      "",
      "Co-authored-by: Someone <someone@example.invalid>",
      "CO-AUTHORED-BY: helper[bot] <1+helper[bot]@users.noreply.github.com>  ",
      "",
      "* Tidy the port",
      "",
      "The rest of the message comes after it.",
    ].join("\n"),
    files: ["packages/sdk/src/middle-trailer.ts"],
  },
  {
    title: "Write the note under a trailer (#220)",
    body: [
      "Co-authored-by: ---- <----@example.invalid>",
      "Release-note: A note right under a trailer line is listed.",
      "and some prose.",
    ].join("\n"),
    files: ["packages/sdk/src/under-trailer.ts"],
  },
];

const ported = "6".repeat(40);

/**
 * Ports whose markers or co-authors are not what a credit is built from. Each note but the last two
 * is listed, with no link or mention but the one valid pull request and handle.
 */
const ports: ReadonlyArray<Merge> = [
  {
    title: "Port from another repository (#501)",
    body: [
      "Release-note: Ports credit only the public repository.",
      "",
      `Public-PR: UsefulSoftwareCo/executor-v3#2501 ${ported}`,
      `Public-PR: SomeoneElse/executor#2502 ${ported}`,
    ].join("\n"),
    files: ["packages/sdk/src/port-repository.ts"],
  },
  {
    title: "Port with a malformed number (#502)",
    body: [
      "Release-note: Ports credit only a pull request number.",
      "",
      `Public-PR: UsefulSoftwareCo/executor#2503th ${ported}`,
      `Public-PR: UsefulSoftwareCo/executor#2504 ${ported} and more`,
      `Public-PR: UsefulSoftwareCo/executor#${"9".repeat(20)} ${ported}`,
    ].join("\n"),
    files: ["packages/sdk/src/port-number.ts"],
  },
  {
    title: "Port with odd co-authors (#503)",
    body: [
      "Release-note: Ports thank only GitHub handles.",
      "",
      `Public-PR: UsefulSoftwareCo/executor#2505 ${ported}`,
      "",
      "Co-authored-by: Dotted <1+evil.example@users.noreply.github.com>",
      "Co-authored-by: Elsewhere <evil@example.invalid>",
      "Co-authored-by: Lookalike <1+evil@users.noreply.github.com.example.invalid>",
      `Co-authored-by: Long <1+${"a".repeat(40)}@users.noreply.github.com>`,
      "Co-authored-by: Leading <1+-evil@users.noreply.github.com>",
      "Co-authored-by: Doubled <1+ev--il@users.noreply.github.com>",
      "Co-authored-by: Trailing <evil-@users.noreply.github.com>",
      `Co-authored-by: Longest <1+${"b".repeat(39)}@users.noreply.github.com>`,
    ].join("\n"),
    files: ["packages/sdk/src/port-handles.ts"],
  },
  {
    // A handle with a slash or an @ is no address a trailer may hold, so the message has no notes.
    title: "Port with a slashed handle (#504)",
    body: `Release-note: Private slashed handle text.\n\nPublic-PR: UsefulSoftwareCo/executor#2506 ${ported}\n\nCo-authored-by: Slash <1+evil/x@users.noreply.github.com>`,
    files: ["packages/sdk/src/port-slash.ts"],
  },
  {
    title: "Port with a doubled at (#505)",
    body: `Release-note: Private doubled at text.\n\nPublic-PR: UsefulSoftwareCo/executor#2507 ${ported}\n\nCo-authored-by: At <1+evil@x@users.noreply.github.com>`,
    files: ["packages/sdk/src/port-at.ts"],
  },
];

/** A change, its revert, and the revert of that revert, which restores it. */
const restored: ReadonlyArray<Merge> = [
  {
    title: "Open workspaces from the tray (#204)",
    body: "Release-note: Workspaces open from the tray.",
    files: ["packages/sdk/src/tray.ts"],
  },
  {
    title: 'Revert "Open workspaces from the tray (#204)" (#205)',
    files: ["packages/sdk/src/tray.ts"],
  },
  {
    title: 'Revert "Revert "Open workspaces from the tray (#204)" (#205)" (#206)',
    files: ["packages/sdk/src/tray.ts"],
  },
];

/** A merge's title as the notes would have printed it, without its private number. */
const titleOf = (merge: Merge) => merge.title.replace(/\s*\(#\d+\)$/u, "");

layer(NodeServices.layer, { excludeTestServices: true })("Release notes", (it) => {
  it.effect(
    "list only the Release-note lines of shipped changes, print no title, count the rest and credit a port by handle",
    () =>
      Effect.gen(function* () {
        const repos = yield* repositories(merges);
        const result = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
        expect(result.exitCode, result.stderr).toBe(0);
        const [changes = "", install = ""] = result.stdout.split("\n## Install\n");
        expect(changes.trim()).toBe(
          [
            // beta.6 is higher and beta.3 older: the release before beta.5 is beta.4.
            "## Changes since 2.0.0-beta.4",
            "",
            "### All installs",
            "",
            "- Each app's card now shows its accounts.",
            "- Fix a sign-in failure with some identity providers",
            "",
            "### CLI and desktop",
            "",
            "- The upgrade command takes --rollback to go back to the version you had before.",
            "",
            "### Self-host",
            "",
            "- A self-hosted Executor behind a proxy no longer answers 502.",
            "- A self-hosted Executor limits each client behind trusted proxies on its own. ([#2436](https://github.com/UsefulSoftwareCo/executor/pull/2436), thanks @danizord)",
            "",
            // Globex, the rollback test, the split, the Cloud-only line, CI, the fixture, the
            // README, the tsgo pin, Jane's (none), the private repository's line and the port's
            // tests; the banner's removal and its revert cancel, and the release commit is not a
            // change.
            "Not listed: 11 other changes.",
          ].join("\n"),
        );
        // The install instructions at the top of the release scripts' README, without its title
        // or its maintainers' sections.
        expect(install).toContain("Install with npm, `npm i -g executor@beta`");
        expect(install).not.toContain("# Executor 2 beta");
        expect(install).not.toContain("## Build for review");
        // A private repository's line and the tsgo pin's message are left out with a warning that
        // names the commit, the line and the reason only.
        const shaOf = (number: string) =>
          repos.merged[merges.findIndex((merge) => merge.title.includes(`(#${number})`))]!;
        expect(result.stderr).toContain(
          `::warning title=Release notes::${shaOf("111")} line 3 has a Release-note: line that names a private repository, so the notes leave it out.`,
        );
        expect(result.stderr).toContain(
          `::warning title=Release notes::${shaOf("108")} has a message that holds "<", which can hide text when GitHub renders it, so none of its Release-note: lines are counted.`,
        );
        // So is the line on the Cloud-only change, in the private job log, never in the notes.
        const cloudOnly = repos.merged[merges.findIndex((merge) => merge.title.includes("#117"))]!;
        expect(result.stderr).toContain(
          `::warning title=Release notes::${cloudOnly} has a Release-note: line on a change to nothing a release ships (Cloud-only, CI, tests or tooling), so the notes leave it out.`,
        );
        // The notes name no commit, and link nowhere but the public pull request they credit.
        for (const sha of [repos.beta4, ...repos.merged])
          expect(result.stdout, sha).not.toContain(sha.slice(0, 7));
        expect(changes).not.toContain("compare/");
        // No pull request title reaches the notes or the log, listed or not.
        const everything = `${result.stdout}\n${result.stderr}`;
        for (const merge of merges) expect(everything, merge.title).not.toContain(titleOf(merge));
        for (const secret of [
          "Acme",
          "Jane",
          "Globex",
          "executor-next",
          "Daniel",
          "corp.example",
          "devin",
          "billed",
          "banner",
          "earlier draft",
          "tsgo",
        ])
          expect(everything, secret).not.toContain(secret);
      }),
  );

  it.effect(
    "a release whose changes have no Release-note line says no notes were written, and still publishes",
    () =>
      Effect.gen(function* () {
        const repos = yield* repositories(merges);
        // Up to the first two merges after beta.4: a shipped fix and a test, neither with a line.
        const result = yield* notes(repos, ["--version", "2.0.0-beta.5", "--to", repos.merged[1]!]);
        expect(result.exitCode, result.stderr).toBe(0);
        const [changes = "", install = ""] = result.stdout.split("\n## Install\n");
        expect(changes.trim()).toBe(
          [
            "## Changes since 2.0.0-beta.4",
            "",
            "No release notes were written for this release.",
            "",
            "Not listed: 2 changes.",
          ].join("\n"),
        );
        expect(install).toContain("Install with npm, `npm i -g executor@beta`");
        const everything = `${result.stdout}\n${result.stderr}`;
        for (const merge of merges.slice(0, 2))
          expect(everything, merge.title).not.toContain(titleOf(merge));
      }),
  );

  it.effect("a release with only automated commits says nothing changed", () =>
    Effect.gen(function* () {
      const repos = yield* repositories(merges);
      const result = yield* notes(repos, ["--version", "2.0.0-beta.4", "--to", repos.beta4]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.split("\n## Install\n")[0]!.trim()).toBe(
        ["## Changes since 2.0.0-beta.3", "", "No changes since 2.0.0-beta.3."].join("\n"),
      );
    }),
  );

  it.effect("the notes are written to --output, and an unknown previous source stops them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repos = yield* repositories(merges);
      const output = path.join(repos.main, "..", "out", "notes.md");
      const written = yield* notes(repos, ["--version", "2.0.0-beta.5", "--output", output]);
      expect(written.exitCode, written.stderr).toBe(0);
      expect(written.stdout).toBe("");
      expect(yield* fs.readFileString(output)).toContain("## Changes since 2.0.0-beta.4\n");

      // beta.6 exports a commit main does not hold, so beta.7's range has no start.
      const unknown = yield* notes(repos, ["--version", "2.0.0-beta.7"]);
      expect(unknown.exitCode).not.toBe(0);
      // NodeRuntime.runMain logs the failure to stdout.
      expect(unknown.stdout).toContain(
        "executor@2.0.0-beta.6 exports abcdef0, which this checkout does not hold. It needs main's history (fetch-depth: 0).",
      );
      // No release is older than beta.3.
      const first = yield* notes(repos, ["--version", "2.0.0-beta.3", "--to", repos.first]);
      expect(first.exitCode).not.toBe(0);
      expect(first.stdout).toContain("has no executor@ release tag below 2.0.0-beta.3.");
    }),
  );
  it.effect(
    "the notes read the same from a checkout without file contents whose origin cannot be reached, as the metadata job's",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const repos = yield* repositories(merges);
        const full = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
        expect(full.exitCode, full.stderr).toBe(0);
        yield* git(repos.main, "config", "uploadpack.allowFilter", "true");
        const blobless = path.join(repos.main, "..", "blobless");
        yield* git(
          path.dirname(blobless),
          "clone",
          "--quiet",
          "--filter=blob:none",
          "--no-checkout",
          `file://${repos.main}`,
          blobless,
        );
        // The job's checkout keeps no credentials, so it cannot fetch a missing file either.
        yield* git(blobless, "remote", "set-url", "origin", "file:///nonexistent");
        const result = yield* notes({ ...repos, main: blobless }, ["--version", "2.0.0-beta.5"]);
        expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
        expect(result.stdout).toBe(full.stdout);
      }),
  );
  it.effect(
    "a Release-note line counts only at the start of a line of its own, and each one is listed",
    () =>
      Effect.gen(function* () {
        const repos = yield* repositories(examples);
        const result = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
        expect(result.exitCode, result.stderr).toBe(0);
        const [changes = ""] = result.stdout.split("\n## Install\n");
        expect(changes.trim()).toBe(
          [
            "## Changes since 2.0.0-beta.4",
            "",
            "### All installs",
            "",
            // Each valid line of one change, once, in order; `none` among them is no line.
            "- Notes list each line of a change.",
            "- A second line of the same change is listed too.",
            "",
            // The revert of a change released before, which has no line of its own.
            "Not listed: 1 other change.",
          ].join("\n"),
        );
        const everything = `${result.stdout}\n${result.stderr}`;
        for (const example of ["INDENTED", "QUOTED", "INLINE", "REVERTED"])
          expect(everything, example).not.toContain(example);
        // Each line that looks like a note but is not one is named in the private job log by its
        // commit and line (the title is line 1), never its text.
        const warnings = (sha: string) =>
          result.stderr
            .split("\n")
            .filter((line) => line.startsWith(`::warning title=Release notes::${sha} `));
        expect(warnings(repos.merged[0]!)).toEqual(
          [
            "line 10 has Release-note: indented, so it is not counted.",
            "line 12 has Release-note: quoted, so it is not counted.",
            "line 14 has Release-note: other than at the start of its line, so it is not counted.",
          ].map((warning) => `::warning title=Release notes::${repos.merged[0]} ${warning}`),
        );
        expect(warnings(repos.merged[1]!)).toEqual([
          `::warning title=Release notes::${repos.merged[1]} line 7 has Release-note: quoted, so it is not counted.`,
        ]);
      }),
  );

  it.effect(
    "a message that holds <, [, $ or a code fence anywhere has no notes, and the log says which it holds",
    () =>
      Effect.gen(function* () {
        const repos = yield* repositories(hidden.map(({ merge }) => merge));
        const result = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
        expect(result.exitCode, result.stderr).toBe(0);
        const [changes = ""] = result.stdout.split("\n## Install\n");
        expect(changes.trim()).toBe(
          [
            "## Changes since 2.0.0-beta.4",
            "",
            "No release notes were written for this release.",
            "",
            `Not listed: ${hidden.length} changes.`,
          ].join("\n"),
        );
        // One warning each, naming the commit and the character, never a line's text.
        for (const [index, { holds }] of hidden.entries()) {
          const sha = repos.merged[index]!;
          expect(
            result.stderr
              .split("\n")
              .filter((line) => line.startsWith(`::warning title=Release notes::${sha} `)),
          ).toEqual([
            `::warning title=Release notes::${sha} has a message that holds ${JSON.stringify(holds)}, which can hide text when GitHub renders it, so none of its Release-note: lines are counted.`,
          ]);
        }
        const everything = `${result.stdout}\n${result.stderr}`;
        for (const secret of [
          "PRIVATE_COMMENT_REOPEN",
          "Private",
          "DETAILS_EXAMPLE",
          "FENCED",
          "TILDES",
        ])
          expect(everything, secret).not.toContain(secret);
      }),
  );

  it.effect(
    "a note is listed as written only when it is plain prose, and any other is left out whole with its reason",
    () =>
      Effect.gen(function* () {
        const byLine = refusedNotes.filter(({ message }) => message !== true);
        const byMessage = refusedNotes.filter(({ message }) => message === true);
        const repos = yield* repositories([
          {
            title: "Write plain notes (#210)",
            body: acceptedNotes.map((note) => `Release-note: ${note}`).join("\n"),
            files: ["packages/sdk/src/plain.ts"],
          },
          {
            title: "Write notes GitHub would render (#211)",
            body: byLine.map(({ note }) => `Release-note: ${note}`).join("\n"),
            files: ["packages/sdk/src/rendered.ts"],
          },
          ...byMessage.map(({ note }, index) => ({
            title: `Write a note that refuses its message (#${220 + index})`,
            body: `Release-note: ${note}`,
            files: [`packages/sdk/src/message-${index}.ts`],
          })),
        ]);
        const result = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
        expect(result.exitCode, result.stderr).toBe(0);
        const [changes = ""] = result.stdout.split("\n## Install\n");
        expect(changes.trim()).toBe(
          [
            "## Changes since 2.0.0-beta.4",
            "",
            "### All installs",
            "",
            ...acceptedNotes.map((note) => `- ${note}`),
            "",
            // Every one of their lines was refused, so the other changes are not listed.
            `Not listed: ${1 + byMessage.length} other changes.`,
          ].join("\n"),
        );
        expect(realisticNotes).toHaveLength(20);
        expect(hexWordNotes).toHaveLength(17);
        const warnings = (sha: string) =>
          result.stderr
            .split("\n")
            .filter((line) => line.startsWith(`::warning title=Release notes::${sha} `));
        // Each refused line is named by its commit, line and reason (the title is line 1), never
        // rewritten into the notes.
        expect(warnings(repos.merged[1]!)).toEqual(
          byLine.map(
            ({ reason }, index) =>
              `::warning title=Release notes::${repos.merged[1]} line ${index + 3} has a Release-note: line that ${reason}, so the notes leave it out.`,
          ),
        );
        // A note that holds <, [ or $ refuses its whole message.
        for (const [index, { reason }] of byMessage.entries())
          expect(warnings(repos.merged[2 + index]!)).toEqual([
            `::warning title=Release notes::${repos.merged[2 + index]} has a message that ${reason}, which can hide text when GitHub renders it, so none of its Release-note: lines are counted.`,
          ]);
        expect(warnings(repos.merged[0]!)).toEqual([]);
        for (const word of ["someone", "shipit", "evil", "example", "tsgo", "deadbeef", "GHSA"])
          expect(result.stdout, word).not.toContain(word);
      }),
  );

  it.effect("a revert of a revert restores the change it reverted, and its note", () =>
    Effect.gen(function* () {
      const repos = yield* repositories(restored);
      const result = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
      expect(result.exitCode, result.stderr).toBe(0);
      const [changes = ""] = result.stdout.split("\n## Install\n");
      // The revert and the revert of it cancel; the change stands.
      expect(changes.trim()).toBe(
        [
          "## Changes since 2.0.0-beta.4",
          "",
          "### All installs",
          "",
          "- Workspaces open from the tray.",
        ].join("\n"),
      );
    }),
  );

  it.effect(
    "a note longer than 300 characters is left out, and so are notes past 10,000 characters in all",
    () =>
      Effect.gen(function* () {
        const long = "Executor starts faster. ".repeat(6_250);
        expect(long.length).toBe(150_000);
        // 40 notes of 290 characters each.
        const many = Array.from({ length: 40 }, (_, index) => {
          const start = `Change ${String(index + 1).padStart(2, "0")}: `;
          return start + "x".repeat(290 - start.length);
        });
        const repos = yield* repositories([
          {
            title: "Explain everything (#301)",
            body: `Release-note: ${long}`,
            files: ["packages/sdk/src/long.ts"],
          },
          ...many.map((note, index) => ({
            title: `Change ${index + 1} (#${400 + index})`,
            body: `Release-note: ${note}`,
            files: [`packages/sdk/src/change-${index + 1}.ts`],
          })),
        ]);
        const result = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
        // Commit messages on main cannot be edited, so a long note never stops a release.
        expect(result.exitCode, result.stderr).toBe(0);
        const [changes = ""] = result.stdout.split("\n## Install\n");
        const listed = changes.split("\n").filter((line) => line.startsWith("- "));
        // The long note is left out whole: a cut could drop a caveat and change what it says.
        expect(changes).not.toContain("Executor starts faster");
        expect(result.stderr).toContain(
          `::warning title=Release notes::${repos.merged[0]} line 3 has a Release-note: line that is longer than 300 characters, so the notes leave it out.`,
        );
        // 34 lines of 292 characters fill 9,928 of the 10,000; the 35th would pass it, so it and
        // every later note are left out and counted, with the long one.
        expect(listed).toEqual(many.slice(0, 34).map((note) => `- ${note}`));
        expect(listed.join("").length).toBeLessThanOrEqual(10_000);
        expect(changes).toContain("Not listed: 7 other changes.");
        for (const sha of repos.merged.slice(35))
          expect(result.stderr).toContain(
            `::warning title=Release notes::${sha} has a Release-note: line past the 10,000 characters the notes hold, so the notes leave it out.`,
          );
        expect(result.stdout.length).toBeLessThan(20_000);
      }),
  );

  it.effect(
    "a co-author's address and bot name are allowed on a line that is only a trailer, anywhere in a message",
    () =>
      Effect.gen(function* () {
        const repos = yield* repositories(trailered);
        const result = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
        expect(result.exitCode, result.stderr).toBe(0);
        const [changes = ""] = result.stdout.split("\n## Install\n");
        expect(changes.trim()).toBe(
          [
            "## Changes since 2.0.0-beta.4",
            "",
            "### All installs",
            "",
            "- Co-authors in the trailer block leave a note listed.",
            "- A note among the trailers is listed too.",
            "- A trailer in the middle of a message leaves a note listed.",
            "- A note right under a trailer line is listed.",
          ].join("\n"),
        );
        expect(result.stderr).not.toContain("::warning");
      }),
  );

  it.effect(
    "a port's credit links only the public repository's pull request and mentions only GitHub handles of noreply addresses",
    () =>
      Effect.gen(function* () {
        const repos = yield* repositories(ports);
        const result = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
        expect(result.exitCode, result.stderr).toBe(0);
        const [changes = ""] = result.stdout.split("\n## Install\n");
        expect(changes.trim()).toBe(
          [
            "## Changes since 2.0.0-beta.4",
            "",
            "### All installs",
            "",
            // A marker that is not exactly the public repository and a number credits nothing,
            // and its note is listed as a change that ports nothing.
            "- Ports credit only the public repository.",
            "- Ports credit only a pull request number.",
            // Only the handle that meets GitHub's rule is thanked.
            `- Ports thank only GitHub handles. ([#2505](https://github.com/UsefulSoftwareCo/executor/pull/2505), thanks @${"b".repeat(39)})`,
            "",
            // The slashed handle and the doubled at.
            "Not listed: 2 other changes.",
          ].join("\n"),
        );
        // The only link and the only mention are the valid port's.
        expect(changes.match(/\]\(/gu)).toHaveLength(1);
        expect(changes.match(/@/gu)).toHaveLength(1);
        for (const word of ["evil", "a".repeat(40), "#2501", "#2502", "#2503", "#2504", "Someone"])
          expect(changes, word).not.toContain(word);
        for (const word of ["executor-v3", "SomeoneElse", "9".repeat(20), "Private"])
          expect(result.stdout, word).not.toContain(word);
        // Each marker and co-author not read is named in the private job log by commit and line.
        const warnings = (sha: string) =>
          result.stderr
            .split("\n")
            .filter((line) => line.startsWith(`::warning title=Release notes::${sha} `));
        const unread = (sha: string, line: number) =>
          `::warning title=Release notes::${sha} line ${line} has a Public-PR: line that is not Public-PR: UsefulSoftwareCo/executor#<number> <40-hex sha>, so the notes credit nothing from it.`;
        expect(warnings(repos.merged[0]!)).toEqual(
          [5, 6].map((line) => unread(repos.merged[0]!, line)),
        );
        expect(warnings(repos.merged[1]!)).toEqual(
          [5, 6, 7].map((line) => unread(repos.merged[1]!, line)),
        );
        expect(warnings(repos.merged[2]!)).toEqual(
          [7, 8, 9, 10, 11, 12, 13].map(
            (line) =>
              `::warning title=Release notes::${repos.merged[2]} line ${line} has a Co-authored-by: trailer without a users.noreply.github.com address that names a GitHub handle, so the notes thank no one for it.`,
          ),
        );
        for (const sha of repos.merged.slice(3))
          expect(warnings(sha)).toEqual([
            `::warning title=Release notes::${sha} has a message that holds "<", which can hide text when GitHub renders it, so none of its Release-note: lines are counted.`,
          ]);
      }),
  );

  it.effect(
    "--json lists this release's notes and those of the releases before it as plain text by area, newest first, without a port's credit",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repos = yield* repositories(
          [
            {
              title: "Show app accounts on the Apps cards (#101)",
              body: "Release-note: Each app's card now shows its accounts.",
              files: ["packages/sdk/src/accounts.ts"],
            },
            {
              title: "Fix self-host 502s behind a proxy (#103)",
              body: "Release-note: A self-hosted Executor behind a proxy no longer answers 502.",
              files: ["apps/hosted/self-host/src/proxy.ts"],
            },
            {
              title: "Rate-limit each self-host client (#112)",
              body: `Release-note: A ported change is listed without its credit.\n\n${portMarker}\n\n${portTrailers}`,
              files: ["apps/hosted/self-host/src/limit.ts"],
            },
            {
              title: "Bill Cloud workspaces by the hour (#117)",
              body: "Release-note: Cloud workspaces are billed by the hour.",
              files: ["apps/hosted/cloud/src/billing.ts"],
            },
          ],
          [
            {
              title: "Speed up search (#90)",
              body: "Release-note: Search answers faster.",
              files: ["packages/sdk/src/search.ts"],
            },
            {
              title: "Add executor upgrade (#91)",
              body: "Release-note: The upgrade command updates Executor in place.",
              files: ["apps/cli/src/upgrade.ts"],
            },
            {
              title: "Hide a note (#92)",
              body: "Release-note: PRIVATE <b>hidden</b> note",
              files: ["packages/sdk/src/hidden.ts"],
            },
          ],
        );
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-notes-json-" });
        const json = `${directory}/notes.json`;
        const result = yield* notes(repos, [
          "--version",
          "2.0.0-beta.5",
          "--output",
          `${directory}/notes.md`,
          "--json",
          json,
          "--history",
          "3",
        ]);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(JSON.parse(yield* fs.readFileString(json))).toEqual({
          // Every release after beta.3 is listed.
          since: "2.0.0-beta.3",
          releases: [
            {
              version: "2.0.0-beta.5",
              // In merge order; the Cloud-only line is left out, as from the Markdown.
              notes: [
                { area: "All installs", text: "Each app's card now shows its accounts." },
                {
                  area: "Self-host",
                  text: "A self-hosted Executor behind a proxy no longer answers 502.",
                },
                { area: "Self-host", text: "A ported change is listed without its credit." },
              ],
            },
            {
              // Against beta.3. Its own release commit is no change, and the hidden note is none.
              version: "2.0.0-beta.4",
              notes: [
                { area: "All installs", text: "Search answers faster." },
                {
                  area: "CLI and desktop",
                  text: "The upgrade command updates Executor in place.",
                },
              ],
            },
            // beta.3 has no release before it in the public repository, so it is not listed.
          ],
        });
        // The Markdown is as without --json: this release only, with the port's credit.
        const markdown = yield* fs.readFileString(`${directory}/notes.md`);
        expect(markdown).toContain("## Changes since 2.0.0-beta.4");
        expect(markdown).toContain("thanks @danizord");
        expect(markdown).not.toContain("Search answers faster.");
        // The earlier release's warnings were its own run's; they are not repeated.
        expect(result.stderr).not.toContain('holds "<"');
        expect(yield* fs.readFileString(json)).not.toContain("PRIVATE");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "--json says since when its list is whole: a release it cannot place ends the list there, and the releases before it are left out, as the desktop feed would refuse them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repos = yield* repositories(
          [
            {
              title: "Show app accounts on the Apps cards (#101)",
              body: "Release-note: Each app's card now shows its accounts.",
              files: ["packages/sdk/src/accounts.ts"],
            },
          ],
          [
            {
              title: "Speed up search (#90)",
              body: "Release-note: Search answers faster.",
              files: ["packages/sdk/src/search.ts"],
            },
          ],
        );
        // 2.0.0 exports main's last merge. Below it, beta.6 exports a commit main does not hold, so
        // nothing places it: 2.0.0 cannot be listed against it. beta.4 could be, against beta.3,
        // but nothing would say that beta.6 and 2.0.0 are missing after it.
        const published = repos.publicRepo.replace(/^file:\/\//u, "");
        yield* git(
          published,
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          `Export ${repos.merged.at(-1)}`,
        );
        yield* git(published, "tag", "executor@2.0.0");
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-notes-since-" });
        const json = `${directory}/notes.json`;
        const result = yield* notes(repos, [
          "--version",
          "2.0.1",
          "--json",
          json,
          "--history",
          "5",
        ]);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stderr).toContain(
          "executor@2.0.0 and the releases before it are left out of the JSON history: executor@2.0.0-beta.6 exports abcdef0, which this checkout does not hold.",
        );
        const written = JSON.parse(yield* fs.readFileString(json));
        // The list is whole only after 2.0.0, and holds nothing before it. `notes` has checked
        // that the desktop feed takes it.
        expect({
          since: written.since,
          versions: written.releases.map((release: { version: string }) => release.version),
        }).toEqual({ since: "2.0.0", versions: ["2.0.1"] });
      }).pipe(Effect.scoped),
  );

  it.effect("--history takes a whole number from 1 to 20", () =>
    Effect.gen(function* () {
      const repos = yield* repositories([]);
      for (const history of ["0", "21", "two"]) {
        const result = yield* notes(repos, [
          "--version",
          "2.0.0-beta.5",
          "--json",
          "/dev/null",
          "--history",
          history,
        ]);
        expect(result.exitCode, history).not.toBe(0);
        // NodeRuntime.runMain logs the failure to stdout.
        expect(result.stdout).toContain(
          `--history takes a whole number from 1 to 20; got ${history}.`,
        );
      }
    }),
  );

  it.effect(
    "desktop-feed.ts puts the notes that reach the desktop into each channel file as electron-updater's releaseNotes with how far back they are whole, and the release workflow checks them as the feed reads them before any build and in the publish job before it makes anything public",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const version = JSON.parse(yield* fs.readFileString("apps/cli/package.json")).version;
        const channel = version.includes("-beta.") ? "beta" : "latest";
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-feed-notes-" });
        // Each platform's electron-builder metadata and the installer bytes it describes.
        const platforms = [
          ["darwin", "arm64", `executor-v2-${channel}-mac.yml`],
          ["darwin", "x64", `executor-v2-${channel}-mac.yml`],
          ["linux", "x64", `executor-v2-${channel}-linux.yml`],
          ["linux", "arm64", `executor-v2-${channel}-linux-arm64.yml`],
          ["win32", "x64", `executor-v2-${channel}.yml`],
        ] as const;
        for (const [platform, arch, file] of platforms) {
          const artifacts = path.join(
            directory,
            "artifacts",
            `${version}-${platform}-${arch}`,
            "desktop-artifacts",
          );
          yield* fs.makeDirectory(artifacts, { recursive: true });
          const bytes = Buffer.from(`${platform}-${arch}`);
          const installer = `executor-desktop-${version}-${platform}-${arch}.zip`;
          yield* fs.writeFile(path.join(artifacts, installer), bytes);
          yield* fs.writeFileString(
            path.join(artifacts, file),
            JSON.stringify({
              version,
              files: [
                {
                  url: installer,
                  sha512: createHash("sha512").update(bytes).digest("base64"),
                  size: bytes.length,
                },
              ],
              releaseDate: "2026-11-17T00:00:00.000Z",
            }),
          );
        }
        const writeNotes = (first: string, since: string | null = "2.0.0-beta.2") =>
          fs.writeFileString(
            path.join(directory, "notes.json"),
            JSON.stringify({
              ...(since === null ? {} : { since }),
              releases: [
                {
                  version: first,
                  notes: [
                    { area: "All installs", text: "Search answers faster." },
                    { area: "Self-host", text: "A self-hosted Executor reads its proxy." },
                    { area: "CLI and desktop", text: "The desktop app has a tray menu." },
                  ],
                },
                { version: "2.0.0-beta.4", notes: [] },
                {
                  version: "2.0.0-beta.3",
                  notes: [{ area: "Self-host", text: "Only self-host changed." }],
                },
              ],
            }),
          );
        const run = (args: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const child = yield* processes.spawn(
              ChildProcess.make("node", ["scripts/releases/desktop-feed.ts", ...args], {
                stdout: "pipe",
                stderr: "pipe",
              }),
            );
            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                child.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            return { log: `${stdout}${stderr}`, exitCode: Number(exitCode) };
          }).pipe(Effect.scoped);
        const feed = (output: string) =>
          run([path.join(directory, "artifacts"), output, path.join(directory, "notes.json")]);
        const check = () => run(["--check-notes", path.join(directory, "notes.json")]);

        yield* writeNotes(version);
        const output = path.join(directory, "feed");
        const result = yield* feed(output);
        expect(result.exitCode, result.log).toBe(0);
        for (const [, , file] of platforms) {
          const written = JSON.parse(yield* fs.readFileString(path.join(output, file)));
          // Newest first; one note per line, the self-host ones left out; none is null.
          expect(written.releaseNotes, file).toEqual([
            { version, note: "Search answers faster.\nThe desktop app has a tray menu." },
            { version: "2.0.0-beta.4", note: null },
            { version: "2.0.0-beta.3", note: null },
          ]);
          // How far back the notes are whole, as the notes say.
          expect(written.releaseNotesSince, file).toBe("2.0.0-beta.2");
        }

        // Notes for another release stop the step rather than describe this one.
        yield* writeNotes("2.0.0-beta.4");
        const wrong = yield* feed(path.join(directory, "wrong"));
        expect(wrong.exitCode).not.toBe(0);
        expect(wrong.log).toContain(`does not start with ${version}`);

        // The feed reads the notes only after the release, the image, npm and Homebrew are public.
        // `--check-notes` reads them as the feed does and writes nothing, so the release workflow
        // runs it where it writes them, in the metadata job, before any build, and on the copy the
        // publish job downloads: notes the feed would refuse stop the release before that job
        // makes anything public.
        const refused = yield* check();
        expect(refused.exitCode).not.toBe(0);
        expect(refused.log).toContain(`does not start with ${version}`);
        yield* fs.writeFileString(path.join(directory, "notes.json"), "{ not json");
        expect((yield* check()).exitCode).not.toBe(0);
        // Notes that do not say how far back they are whole, or that list a release not after
        // that, are refused: the desktop would tell its user what the list does not hold.
        yield* writeNotes(version, null);
        expect((yield* check()).exitCode).not.toBe(0);
        yield* writeNotes(version, "2.0.0-beta.3");
        const notAfter = yield* check();
        expect(notAfter.exitCode).not.toBe(0);
        expect(notAfter.log).toContain("lists a release that is not after its since, 2.0.0-beta.3");
        yield* writeNotes(version);
        const before = yield* fs.readDirectory(directory, { recursive: true });
        const accepted = yield* check();
        expect(accepted.exitCode, accepted.log).toBe(0);
        expect((yield* fs.readDirectory(directory, { recursive: true })).toSorted()).toEqual(
          before.toSorted(),
        );
        const workflow = yield* fs.readFileString(".github/workflows/release-artifacts.yml");
        const metadata = workflow.slice(
          workflow.indexOf("\n  metadata:\n"),
          workflow.indexOf("\n  git-sources:\n"),
        );
        const written = metadata.indexOf("node scripts/releases/release-notes.ts --output");
        const checked = metadata.indexOf(
          'node scripts/releases/desktop-feed.ts --check-notes "$RUNNER_TEMP/release-notes/notes.json"',
        );
        expect({ written: written >= 0, checkedAfter: checked > written }).toEqual({
          written: true,
          checkedAfter: true,
        });
        // The publish job checks the copy it downloaded, as the feed reads it, before its first
        // step that makes anything public: the source export and the draft release.
        const publish = workflow.slice(workflow.indexOf("\n  publish:\n"));
        const downloaded = publish.indexOf(
          "name: release-notes\n          path: .local/release-notes",
        );
        const checkedCopy = publish.indexOf(
          "node scripts/releases/desktop-feed.ts --check-notes .local/release-notes/notes.json",
        );
        const firstPublic = Math.min(
          publish.indexOf("scripts/export-public.sh"),
          publish.indexOf("gh release create"),
          publish.indexOf("docker buildx imagetools create"),
          publish.indexOf("scripts/releases/publish-npm.ts"),
        );
        expect({
          downloaded: downloaded >= 0,
          checkedAfterDownload: checkedCopy > downloaded,
          checkedBeforePublic: checkedCopy >= 0 && checkedCopy < firstPublic,
        }).toEqual({ downloaded: true, checkedAfterDownload: true, checkedBeforePublic: true });
      }).pipe(Effect.scoped),
  );
});
