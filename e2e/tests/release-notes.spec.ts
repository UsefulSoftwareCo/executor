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

const merges: ReadonlyArray<Merge> = [
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
    title: "Split the self-host proxy (#116)",
    moves: [["apps/hosted/self-host/src/proxy.ts", "apps/hosted/self-host/src/proxy-server.ts"]],
    files: [],
  },
  {
    title: "Bill Cloud workspaces by the hour (#117)",
    body: "Release-note: Cloud workspaces are billed by the hour.",
    files: ["apps/hosted/cloud/src/billing.ts"],
  },
  { title: "Run CI on 8 vCPU runners (#105)", files: [".github/workflows/ci.yml"] },
  { title: "Add a deploy fixture (#106)", files: ["packages/sdk/scripts/deploy-fixture.ts"] },
  { title: "Explain the SDK (#107)", files: ["packages/sdk/README.md"] },
  {
    title: "Pin the tsgo version (#108)",
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
    title: 'Revert "Start (#1)" (#207)',
    body: "This reverts commit 0123456.\n\n> Start (#1)\n>\n> Release-note: REVERTED",
    files: ["apps/cli/src/main.ts"],
  },
];

const hidden: ReadonlyArray<{ readonly merge: Merge; readonly holds: string }> = [
  {
    merge: {
      title: "Probe",
      body: "<!--\n--> <!--\nRelease-note: PRIVATE_COMMENT_REOPEN\n-->",
      files: ["packages/sdk/src/reopen.ts"],
    },
    holds: "<",
  },
  {
    merge: {
      title: "Probe",
      body: '<details title="</details>">\nRelease-note: Private attribute details text.\n</details>',
      files: ["packages/sdk/src/attribute.ts"],
    },
    holds: "<",
  },
  {
    merge: {
      title: "<!--",
      body: "Release-note: Private title comment text.\n-->",
      files: ["packages/sdk/src/title.ts"],
    },
    holds: "<",
  },
  {
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
    merge: {
      title: "Credit a reviewer (#216)",
      body: "Release-note: Private trailer comment text.\n\nCo-authored-by: Someone <!--@example.invalid>\n-->",
      files: ["packages/sdk/src/trailer.ts"],
    },
    holds: "<",
  },
  {
    merge: {
      title: "Define a link (#212)",
      body: '[a]: https://example.invalid "\nRelease-note: Private link title text.\n"',
      files: ["packages/sdk/src/link.ts"],
    },
    holds: "[",
  },
  {
    merge: {
      title: "Define a bot link (#217)",
      body: '[bot]: https://example.invalid "\nRelease-note: Private bot link text.\n"\n\nCo-authored-by: helper[bot] <1+helper[bot]@users.noreply.github.com>',
      files: ["packages/sdk/src/bot-link.ts"],
    },
    holds: "[",
  },
  {
    merge: {
      title: "Thank a reviewer (#218)",
      body: "Release-note: Private body address text.\n\nThanks to Someone <someone@example.invalid> for the review.",
      files: ["packages/sdk/src/body-address.ts"],
    },
    holds: "<",
  },
  {
    merge: {
      title: "Credit a reviewer and more (#219)",
      body: "Release-note: Private text after the address.\n\nCo-authored-by: Someone <someone@example.invalid> and friends\n\nThe rest of the message comes after it.",
      files: ["packages/sdk/src/after-address.ts"],
    },
    holds: "<",
  },
  {
    merge: {
      title: "Credit two addresses (#220)",
      body: "Release-note: Private two address text.\n\nCo-authored-by: Someone <someone@example.invalid> <other@example.invalid>\n\nThe rest of the message comes after it.",
      files: ["packages/sdk/src/two-addresses.ts"],
    },
    holds: "<",
  },
  {
    merge: {
      title: "Credit a hidden reviewer (#224)",
      body: "Co-authored-by: x <!--@y>\nRelease-note: Private middle comment text.\n-->\n\nThe rest of the message comes after it.",
      files: ["packages/sdk/src/middle-comment.ts"],
    },
    holds: "<",
  },
  {
    merge: {
      title: "Credit a quoted reviewer (#225)",
      body: "Release-note: Private quoted name text.\n\nCo-authored-by: > Someone <someone@example.invalid>",
      files: ["packages/sdk/src/quoted-name.ts"],
    },
    holds: "<",
  },
  {
    merge: {
      title: "Credit a bot in prose (#221)",
      body: "Release-note: Private bot prose text.\n\nWritten with helper[bot] and its friends.",
      files: ["packages/sdk/src/bot-prose.ts"],
    },
    holds: "[",
  },
  {
    merge: {
      title: "Add a formula (#213)",
      body: "$$\n\\phantom{\nRelease-note: Private math text.\n}\n$$",
      files: ["packages/sdk/src/math.ts"],
    },
    holds: "$",
  },
  {
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
            "Not listed: 11 other changes.",
          ].join("\n"),
        );
        expect(install).toContain("Install with npm, `npm i -g executor@beta`");
        expect(install).not.toContain("# Executor 2 beta");
        expect(install).not.toContain("## Build for review");
        const shaOf = (number: string) =>
          repos.merged[merges.findIndex((merge) => merge.title.includes(`(#${number})`))]!;
        expect(result.stderr).toContain(
          `::warning title=Release notes::${shaOf("111")} line 3 has a Release-note: line that names a private repository, so the notes leave it out.`,
        );
        expect(result.stderr).toContain(
          `::warning title=Release notes::${shaOf("108")} has a message that holds "<", which can hide text when GitHub renders it, so none of its Release-note: lines are counted.`,
        );
        const cloudOnly = repos.merged[merges.findIndex((merge) => merge.title.includes("#117"))]!;
        expect(result.stderr).toContain(
          `::warning title=Release notes::${cloudOnly} has a Release-note: line on a change to nothing a release ships (Cloud-only, CI, tests or tooling), so the notes leave it out.`,
        );
        for (const sha of [repos.beta4, ...repos.merged])
          expect(result.stdout, sha).not.toContain(sha.slice(0, 7));
        expect(changes).not.toContain("compare/");
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

  it.effect(
    "--check reads a branch's commits as GitHub squashes them and fails on a note the release would drop",
    () =>
      Effect.gen(function* () {
        const repos = yield* repositories(merges);
        const base = yield* git(repos.main, "rev-parse", "HEAD");
        const commit = (...message: ReadonlyArray<string>) =>
          git(
            repos.main,
            "commit",
            "--quiet",
            "--allow-empty",
            ...message.flatMap((m) => ["-m", m]),
          );
        const check = (title?: string) =>
          notes(repos, ["--check", base, ...(title === undefined ? [] : ["--title", title])]);

        expect((yield* check()).stdout).toContain("No commits since");

        yield* commit("Add the setting", "Release-note: The settings page has a dark theme.");
        const one = yield* check();
        expect(one.exitCode, one.stdout).toBe(0);
        expect(one.stdout).toContain("Release-note accepted: The settings page has a dark theme.");

        yield* commit("Fix the setting", "Release-note: none");
        expect((yield* check("Add the setting")).exitCode).toBe(0);
        const hiddenByTitle = yield* check("Add the [setting]");
        expect(hiddenByTitle.exitCode).not.toBe(0);
        expect(hiddenByTitle.stdout).toContain('the squashed message holds "["');

        yield* commit(
          "Indent it",
          "  Release-note: Indented.",
          "Release-note: See https://example.com now.",
        );
        const dropped = yield* check("Add the setting");
        expect(dropped.exitCode).not.toBe(0);
        expect(dropped.stdout).toMatch(
          /line \d+ of the squashed message has Release-note: indented/,
        );
        expect(dropped.stdout).toMatch(
          /line \d+ of the squashed message has a Release-note: line that/,
        );
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
      expect(written.exitCode, written.stdout + written.stderr).toBe(0);
      expect(written.stdout).toBe("");
      expect(yield* fs.readFileString(output)).toContain("## Changes since 2.0.0-beta.4\n");

      const unknown = yield* notes(repos, ["--version", "2.0.0-beta.7"]);
      expect(unknown.exitCode).not.toBe(0);
      expect(unknown.stdout).toContain(
        "executor@2.0.0-beta.6 exports abcdef0, which this checkout does not hold. It needs main's history (fetch-depth: 0).",
      );
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
            "- Notes list each line of a change.",
            "- A second line of the same change is listed too.",
            "",
            "Not listed: 1 other change.",
          ].join("\n"),
        );
        const everything = `${result.stdout}\n${result.stderr}`;
        for (const example of ["INDENTED", "QUOTED", "INLINE", "REVERTED"])
          expect(everything, example).not.toContain(example);
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
            `Not listed: ${1 + byMessage.length} other changes.`,
          ].join("\n"),
        );
        expect(realisticNotes).toHaveLength(20);
        expect(hexWordNotes).toHaveLength(17);
        const warnings = (sha: string) =>
          result.stderr
            .split("\n")
            .filter((line) => line.startsWith(`::warning title=Release notes::${sha} `));
        expect(warnings(repos.merged[1]!)).toEqual(
          byLine.map(
            ({ reason }, index) =>
              `::warning title=Release notes::${repos.merged[1]} line ${index + 3} has a Release-note: line that ${reason}, so the notes leave it out.`,
          ),
        );
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
        expect(result.exitCode, result.stderr).toBe(0);
        const [changes = ""] = result.stdout.split("\n## Install\n");
        const listed = changes.split("\n").filter((line) => line.startsWith("- "));
        expect(changes).not.toContain("Executor starts faster");
        expect(result.stderr).toContain(
          `::warning title=Release notes::${repos.merged[0]} line 3 has a Release-note: line that is longer than 300 characters, so the notes leave it out.`,
        );
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
            "- Ports credit only the public repository.",
            "- Ports credit only a pull request number.",
            `- Ports thank only GitHub handles. ([#2505](https://github.com/UsefulSoftwareCo/executor/pull/2505), thanks @${"b".repeat(39)})`,
            "",
            "Not listed: 2 other changes.",
          ].join("\n"),
        );
        expect(changes.match(/\]\(/gu)).toHaveLength(1);
        expect(changes.match(/@/gu)).toHaveLength(1);
        for (const word of ["evil", "a".repeat(40), "#2501", "#2502", "#2503", "#2504", "Someone"])
          expect(changes, word).not.toContain(word);
        for (const word of ["executor-v3", "SomeoneElse", "9".repeat(20), "Private"])
          expect(result.stdout, word).not.toContain(word);
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
          since: "2.0.0-beta.3",
          releases: [
            {
              version: "2.0.0-beta.5",
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
              version: "2.0.0-beta.4",
              notes: [
                { area: "All installs", text: "Search answers faster." },
                {
                  area: "CLI and desktop",
                  text: "The upgrade command updates Executor in place.",
                },
              ],
            },
          ],
        });
        const markdown = yield* fs.readFileString(`${directory}/notes.md`);
        expect(markdown).toContain("## Changes since 2.0.0-beta.4");
        expect(markdown).toContain("thanks @danizord");
        expect(markdown).not.toContain("Search answers faster.");
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
          expect(written.releaseNotes, file).toEqual([
            { version, note: "Search answers faster.\nThe desktop app has a tray menu." },
            { version: "2.0.0-beta.4", note: null },
            { version: "2.0.0-beta.3", note: null },
          ]);
          expect(written.releaseNotesSince, file).toBe("2.0.0-beta.2");
        }

        yield* writeNotes("2.0.0-beta.4");
        const wrong = yield* feed(path.join(directory, "wrong"));
        expect(wrong.exitCode).not.toBe(0);
        expect(wrong.log).toContain(`does not start with ${version}`);

        const refused = yield* check();
        expect(refused.exitCode).not.toBe(0);
        expect(refused.log).toContain(`does not start with ${version}`);
        yield* fs.writeFileString(path.join(directory, "notes.json"), "{ not json");
        expect((yield* check()).exitCode).not.toBe(0);
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

  it.effect(
    "a note's kind, written before it as Feature:, Improvement: or Fix:, is never part of its text, reaches only Cloud's notes, is a fix when not written, and --check says which it counted",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repos = yield* repositories([
          {
            title: "Change the SDK long ago (#499)",
            files: ["packages/sdk/src/old.ts"],
            date: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            title: "Rename teams (#500)",
            body: "Release-note: Feature: Teams can be renamed.",
            files: ["packages/sdk/src/teams.ts"],
          },
          {
            title: "Search faster (#501)",
            body: "Release-note: improvement: Search answers faster.\nRelease-note: Fix: Search no longer drops the last result.",
            files: ["packages/sdk/src/search.ts"],
          },
          {
            title: "Fix the apps page (#502)",
            body: "Release-note: The apps page no longer flickers.",
            files: ["packages/sdk/src/apps.ts"],
          },
          {
            title: "Move the settings page (#503)",
            body: "Release-note: Note: the settings page has moved.",
            files: ["packages/sdk/src/settings.ts"],
          },
          {
            title: "Mark nothing (#504)",
            body: "Release-note: Feature:",
            files: ["packages/sdk/src/empty.ts"],
          },
        ]);
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-note-kinds-" });
        const release = yield* notes(repos, [
          "--version",
          "2.0.0-beta.5",
          "--output",
          `${directory}/notes.md`,
          "--json",
          `${directory}/notes.json`,
        ]);
        expect(release.exitCode, release.stderr).toBe(0);
        expect(release.stderr).toMatch(
          /has a Release-note: line that names its kind, feature, but no note after it, so the notes leave it out/,
        );
        const written = [
          "Teams can be renamed.",
          "Search answers faster.",
          "Search no longer drops the last result.",
          "The apps page no longer flickers.",
          "Note: the settings page has moved.",
        ];
        const markdown = yield* fs.readFileString(`${directory}/notes.md`);
        for (const text of written) expect(markdown).toContain(`- ${text}\n`);
        expect(markdown).not.toMatch(/Feature:|improvement:|Fix:/u);
        expect(JSON.parse(yield* fs.readFileString(`${directory}/notes.json`)).releases[0]).toEqual(
          {
            version: "2.0.0-beta.5",
            notes: written.map((text) => ({ area: "All installs", text })),
          },
        );

        const today = new Date().toISOString().slice(0, 10);
        const cloud = yield* notes({ ...repos, publicRepo: "file:///nonexistent/public" }, [
          "--cloud",
          "-",
        ]);
        expect(cloud.exitCode, cloud.stdout + cloud.stderr).toBe(0);
        expect(JSON.parse(cloud.stdout)).toEqual({
          notes: [
            { date: today, text: "Note: the settings page has moved.", kind: "fix" },
            { date: today, text: "The apps page no longer flickers.", kind: "fix" },
            { date: today, text: "Search answers faster.", kind: "improvement" },
            { date: today, text: "Search no longer drops the last result.", kind: "fix" },
            { date: today, text: "Teams can be renamed.", kind: "feature" },
          ],
        });

        const base = yield* git(repos.main, "rev-parse", "HEAD");
        yield* git(
          repos.main,
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "Add a dark theme",
          "-m",
          "Release-note: Feature: The settings page has a dark theme.\nRelease-note: The settings page no longer flashes white.",
        );
        const checked = yield* notes(repos, ["--check", base]);
        expect(checked.exitCode, checked.stdout + checked.stderr).toBe(0);
        expect(checked.stdout).toContain(
          "Release-note accepted: The settings page has a dark theme.\n  Kind: feature\n",
        );
        expect(checked.stdout).toContain(
          "Release-note accepted: The settings page no longer flashes white.\n  Kind: fix, so Cloud's what's new never leads with it",
        );
        yield* git(
          repos.main,
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "Mark it",
          "-m",
          "Release-note: Improvement:",
        );
        const empty = yield* notes(repos, ["--check", base, "--title", "Add a dark theme"]);
        expect(empty.exitCode).not.toBe(0);
        expect(empty.stdout + empty.stderr).toMatch(
          /has a Release-note: line that names its kind, improvement, but no note after it/,
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a note's kind is cut off before the note rules apply: a note valid only without its kind is listed, one invalid only without it is left out, and the length, character, none and hidden-message rules are a plain note's",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sized = (length: number) =>
          `${`Teams can be renamed${" now".repeat(100)}`.slice(0, length - 1)}.`;
        const longest = sized(300);
        expect(longest.length).toBe(300);
        const repos = yield* repositories([
          {
            title: "Change the SDK long ago (#599)",
            files: ["packages/sdk/src/old.ts"],
            date: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            title: "Rename teams (#600)",
            body: `Release-note: Feature: ${longest}`,
            files: ["packages/sdk/src/teams.ts"],
          },
          {
            title: "Rename teams again (#601)",
            body: `Release-note: Improvement: ${sized(301)}`,
            files: ["packages/sdk/src/teams-again.ts"],
          },
          {
            title: "Ship the beta (#602)",
            body: "Release-note: Feature: (Beta) Teams have colours.",
            files: ["packages/sdk/src/beta.ts"],
          },
          {
            title: "Fix search (#603)",
            body: "Release-note: Fix: Search finds issue #12 again.",
            files: ["packages/sdk/src/search.ts"],
          },
          {
            title: "Open apps faster (#604)",
            body: "Release-note: Feature: PRIVATE apps open faster.\n\nSee [the guide].",
            files: ["packages/sdk/src/open.ts"],
          },
          {
            title: "Quote a note (#605)",
            body: "    Release-note: Feature: INDENTED\n\n> Release-note: Feature: QUOTED",
            files: ["packages/sdk/src/quote.ts"],
          },
          {
            title: "Color teams (#606)",
            body: "Release-note: Feature:Teams have colours.",
            files: ["packages/sdk/src/color.ts"],
          },
          {
            title: "Mark none (#607)",
            body: "Release-note: Improvement: none",
            files: ["packages/sdk/src/none.ts"],
          },
          {
            title: "Tab a kind (#608)",
            body: "Release-note: Feature:\tTeams have colours.",
            files: ["packages/sdk/src/tab.ts"],
          },
          {
            title: "Space a kind (#609)",
            body: "Spaced out.\n\nRelease-note: Feature:  Teams have colours.",
            files: ["packages/sdk/src/spaces.ts"],
          },
        ]);
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "executor-note-kind-rules-",
        });
        const release = yield* notes(repos, [
          "--version",
          "2.0.0-beta.5",
          "--output",
          `${directory}/notes.md`,
          "--json",
          `${directory}/notes.json`,
        ]);
        expect(release.exitCode, release.stderr).toBe(0);
        expect(JSON.parse(yield* fs.readFileString(`${directory}/notes.json`)).releases[0]).toEqual(
          { version: "2.0.0-beta.5", notes: [{ area: "All installs", text: longest }] },
        );
        const markdown = yield* fs.readFileString(`${directory}/notes.md`);
        expect(markdown).toContain(`- ${longest}\n`);
        expect(markdown).not.toMatch(
          /Feature:|Improvement:|Fix:|colours|#12|PRIVATE|INDENTED|QUOTED|^- none/mu,
        );
        for (const reason of [
          "line 3 has a Release-note: line that is longer than 300 characters",
          "line 3 has a Release-note: line that does not start with a letter or a digit",
          'line 3 has a Release-note: line that holds "#", which a note may not',
          'has a message that holds "["',
          "line 3 has Release-note: indented",
          "line 5 has Release-note: quoted",
          "line 3 has a Release-note: line that has a colon followed by something other than a space",
          "line 3 has a Release-note: line that names its kind, improvement, but no note after it",
          "line 3 has a Release-note: line that holds U+0009, which a note may not",
          "line 5 has a Release-note: line that does not start with a letter or a digit",
        ])
          expect(release.stderr).toContain(reason);

        const cloud = yield* notes({ ...repos, publicRepo: "file:///nonexistent/public" }, [
          "--cloud",
          "-",
        ]);
        expect(cloud.exitCode, cloud.stdout + cloud.stderr).toBe(0);
        expect(JSON.parse(cloud.stdout)).toEqual({
          notes: [{ date: new Date().toISOString().slice(0, 10), text: longest, kind: "feature" }],
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "the desktop's update feed carries a note's text without its kind, as the release notes do",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const version = JSON.parse(yield* fs.readFileString("apps/cli/package.json")).version;
        const channel = version.includes("-beta.") ? "beta" : "latest";
        const repos = yield* repositories([
          {
            title: "Rename teams (#700)",
            body: "Release-note: Feature: Teams can be renamed.",
            files: ["packages/sdk/src/teams.ts"],
          },
          {
            title: "Search faster (#701)",
            body: "Release-note: Improvement: Search answers faster.\nRelease-note: Fix: Search no longer drops the last result.",
            files: ["packages/sdk/src/search.ts"],
          },
        ]);
        const published = repos.publicRepo.replace(/^file:\/\//u, "");
        yield* git(published, "commit", "--quiet", "--allow-empty", "-m", `Export ${repos.beta4}`);
        yield* git(published, "tag", "executor@2.0.0-beta.7");
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-feed-kinds-" });
        const json = path.join(directory, "notes.json");
        const written = yield* notes(repos, ["--version", version, "--json", json]);
        expect(written.exitCode, written.stdout + written.stderr).toBe(0);
        const files = [
          ["darwin", "arm64", `executor-v2-${channel}-mac.yml`],
          ["darwin", "x64", `executor-v2-${channel}-mac.yml`],
          ["linux", "x64", `executor-v2-${channel}-linux.yml`],
          ["linux", "arm64", `executor-v2-${channel}-linux-arm64.yml`],
          ["win32", "x64", `executor-v2-${channel}.yml`],
        ] as const;
        for (const [platform, arch, file] of files) {
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
        const output = path.join(directory, "feed");
        const child = yield* processes.spawn(
          ChildProcess.make(
            "node",
            ["scripts/releases/desktop-feed.ts", path.join(directory, "artifacts"), output, json],
            { stdout: "pipe", stderr: "pipe" },
          ),
        );
        const [log, exitCode] = yield* Effect.all(
          [
            Stream.merge(child.stdout, child.stderr).pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        expect(Number(exitCode), log).toBe(0);
        for (const [, , file] of files) {
          const feed = JSON.parse(yield* fs.readFileString(path.join(output, file)));
          expect(feed.releaseNotes[0], file).toEqual({
            version,
            note: "Teams can be renamed.\nSearch answers faster.\nSearch no longer drops the last result.",
          });
          expect(JSON.stringify(feed.releaseNotes), file).not.toMatch(/Feature|Improvement|Fix:/u);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a note merged before kinds could be written has the kind scripts/releases/note-kinds.ts gives it only on its own pull request and with its exact text, an entry whose change has left Cloud's window is not listed, and the failed tool calls note it no longer marks is a fix",
    () =>
      Effect.gen(function* () {
        const hosts =
          "The connect account dialog now sums up a long list of hosts a credential may be sent to by domain, with a button that shows every host.";
        const interrupted =
          "Agents are now told to run independent tool calls so that one failure keeps the other results, and when one of several tool calls running together fails, the error now says the others were interrupted, that finished calls did run, and how to keep their results.";
        const repos = yield* repositories([
          {
            title: "Shorten the connect form's host list long ago (#4903)",
            body: `Release-note: ${hosts}`,
            files: ["apps/hosted/cloud/src/hosts-old.ts"],
            date: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            title: "Shorten the connect form's host list (#4903)",
            body: `Release-note: ${hosts}\nRelease-note: The connect account dialog opens faster.`,
            files: ["apps/hosted/cloud/src/hosts.ts"],
          },
          {
            title:
              "Explain interrupted calls when a program fails with calls still running (#4972)",
            body: `Release-note: ${interrupted}`,
            files: ["apps/hosted/cloud/src/calls.ts"],
          },
          {
            title: "Copy the host list (#4999)",
            body: `Release-note: ${hosts}`,
            files: ["apps/hosted/cloud/src/hosts-copy.ts"],
          },
        ]);
        const cloud = yield* notes({ ...repos, publicRepo: "file:///nonexistent/public" }, [
          "--cloud",
          "-",
        ]);
        expect(cloud.exitCode, cloud.stdout + cloud.stderr).toBe(0);
        const today = new Date().toISOString().slice(0, 10);
        expect(JSON.parse(cloud.stdout)).toEqual({
          notes: [
            { date: today, text: hosts, kind: "fix" },
            { date: today, text: interrupted, kind: "fix" },
            { date: today, text: hosts, kind: "improvement" },
            { date: today, text: "The connect account dialog opens faster.", kind: "fix" },
          ],
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "--cloud lists the newest notes of the last 30 days on changes that reach Cloud, Cloud-only ones and ones that also change another product's own code included, without asking the public repository",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
        const selection: ReadonlyArray<Merge> = [
          {
            title: "Change Cloud long ago (#300)",
            body: "Release-note: PRIVATE old Cloud note.",
            files: ["apps/hosted/cloud/src/old.ts"],
            date: old,
          },
          {
            title: "Show Cloud news (#301)",
            body: "Release-note: Cloud members see what is new.",
            files: ["apps/hosted/cloud/web/src/news.ts"],
          },
          {
            title: "Open the hosted dashboard faster (#302)",
            body: "Release-note: The dashboard opens faster.",
            files: ["apps/hosted/web/src/open.ts"],
          },
          {
            title: "Show app accounts on the Apps cards (#303)",
            body: "Release-note: Each app's card now shows its accounts.",
            files: ["packages/sdk/src/accounts.ts"],
          },
          {
            title: "Add executor upgrade --rollback (#304)",
            body: "Release-note: PRIVATE the CLI alone.",
            files: ["apps/cli/src/upgrade.ts", "apps/local/desktop/src/menu.ts"],
          },
          {
            title: "Share sign-in limits per client (#309)",
            body: "Release-note: Sign-in limits apply to each client on its own.",
            files: ["apps/hosted/cloud/src/limits.ts", "apps/local/server/src/limits.ts"],
          },
          {
            title: "Fix self-host 502s behind a proxy (#305)",
            body: "Release-note: PRIVATE the self-host image alone.",
            files: ["apps/hosted/self-host/src/proxy.ts", "apps/docs/content/run/self-host.mdx"],
          },
          {
            title: "Document self-host settings (#306)",
            body: "Release-note: PRIVATE the docs alone.",
            files: ["apps/docs/content/run/settings.mdx", ".changeset/settings.md"],
          },
          {
            title: "Test Cloud (#307)",
            body: "Release-note: PRIVATE tests and CI alone.",
            files: ["e2e/tests/cloud.spec.ts", ".github/workflows/ci.yml", "notes/cloud.md"],
          },
          {
            title: "Hide a Cloud note (#308)",
            body: "Release-note: PRIVATE <b>hidden</b> Cloud note.",
            files: ["apps/hosted/cloud/src/hidden.ts"],
          },
          {
            title: "Name Cloud's teams (#311)",
            body: "Release-note: Teams have names.\nRelease-note: A team's name shows on its page.",
            files: ["apps/hosted/cloud/src/teams.ts"],
          },
        ];
        const numbered: ReadonlyArray<Merge> = Array.from({ length: 11 }, (_, index) => ({
          title: `Cloud change ${index + 1} (#${320 + index})`,
          body: `Release-note: Cloud change number ${index + 1}.`,
          files: [`apps/hosted/cloud/src/change-${index + 1}.ts`],
        }));
        const repos = yield* repositories([...selection, ...numbered]);
        const today = new Date().toISOString().slice(0, 10);
        const offline = { main: repos.main, publicRepo: "file:///nonexistent/public" };
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-cloud-notes-" });

        const selected = yield* notes(offline, [
          "--cloud",
          `${directory}/cloud.json`,
          "--to",
          repos.merged[selection.length - 1]!,
        ]);
        expect(selected.exitCode, selected.stdout + selected.stderr).toBe(0);
        expect(JSON.parse(yield* fs.readFileString(`${directory}/cloud.json`))).toEqual({
          notes: [
            { date: today, text: "Teams have names.", kind: "fix" },
            { date: today, text: "A team's name shows on its page.", kind: "fix" },
            { date: today, text: "Sign-in limits apply to each client on its own.", kind: "fix" },
            { date: today, text: "Each app's card now shows its accounts.", kind: "fix" },
            { date: today, text: "The dashboard opens faster.", kind: "fix" },
            { date: today, text: "Cloud members see what is new.", kind: "fix" },
          ],
        });

        const newest = yield* notes(offline, ["--cloud", "-"]);
        expect(newest.exitCode, newest.stderr).toBe(0);
        expect(JSON.parse(newest.stdout)).toEqual({
          notes: Array.from({ length: 10 }, (_, index) => ({
            date: today,
            text: `Cloud change number ${11 - index}.`,
            kind: "fix",
          })),
        });
        expect(newest.stdout + selected.stdout).not.toContain("PRIVATE");
        expect(yield* fs.readFileString(`${directory}/cloud.json`)).not.toContain("PRIVATE");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "scripts/releases/note-audiences.ts gives any note with an entry's hash exactly the products the entry names, narrower or wider than its files, in Cloud's notes, a release's headings and the desktop feed alike, and any other note goes to every product its change reaches",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const desktop =
          "The desktop app no longer interrupts you with a dialog when an update is ready; a card in the sidebar shows it, and you can restart to install it from there.";
        const tokens =
          "Revoking the Executor app's automatically created token no longer breaks its management tools, the Tokens page marks that token, and connecting an Executor API key account checks the organization first.";
        const updates =
          "Self-hosted servers now check once a day for a newer release and show owners and admins how to update; the docs explain what the check sends and how to turn it off.";
        const skills =
          "MCP clients that support the Skills extension now list and load the skills of every app you can see, straight from Executor.";
        const shared = ["packages/ui/src/shell.ts", "apps/local/desktop/src/updates.ts"];
        const merges: ReadonlyArray<Merge> = [
          {
            title: "Change the SDK long ago (#4799)",
            files: ["packages/sdk/src/old.ts"],
            date: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            title: "Move a notice (#4877)",
            body: `Release-note: ${desktop}\nRelease-note: The sidebar draws faster.`,
            files: shared,
          },
          {
            title: "Copy the notice (#4878)",
            body: `Release-note: ${desktop}`,
            files: [...shared, "packages/ui/src/copy.ts"],
          },
          {
            title: "Mark a token (#5143)",
            body: `Release-note: ${tokens}`,
            files: ["apps/hosted/cloud/src/tokens.ts"],
          },
          {
            title: "Check for updates (#4924)",
            body: `Release-note: ${updates}`,
            files: ["apps/docs/content/run/self-host.mdx"],
          },
          {
            title: "Serve a feature (#5407)",
            body: `Release-note: Feature: ${skills}`,
            files: ["apps/hosted/server/src/mcp.ts", "apps/local/server/src/mcp.ts"],
          },
        ];
        const repos = yield* repositories(merges);
        const today = new Date().toISOString().slice(0, 10);
        const cloud = yield* notes({ ...repos, publicRepo: "file:///nonexistent/public" }, [
          "--cloud",
          "-",
        ]);
        expect(cloud.exitCode, cloud.stdout + cloud.stderr).toBe(0);
        expect(JSON.parse(cloud.stdout)).toEqual({
          notes: [
            { date: today, text: skills, kind: "feature" },
            { date: today, text: tokens, kind: "fix" },
            { date: today, text: "The sidebar draws faster.", kind: "fix" },
          ],
        });

        const version = JSON.parse(yield* fs.readFileString("apps/cli/package.json")).version;
        const channel = version.includes("-beta.") ? "beta" : "latest";
        const published = repos.publicRepo.replace(/^file:\/\//u, "");
        yield* git(published, "commit", "--quiet", "--allow-empty", "-m", `Export ${repos.beta4}`);
        yield* git(published, "tag", "executor@2.0.0-beta.7");
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-note-audiences-" });
        const json = path.join(directory, "notes.json");
        const release = yield* notes(repos, [
          "--version",
          version,
          "--output",
          `${directory}/notes.md`,
          "--json",
          json,
        ]);
        expect(release.exitCode, release.stderr).toBe(0);
        expect(JSON.parse(yield* fs.readFileString(json)).releases[0]).toEqual({
          version,
          notes: [
            { area: "CLI and desktop", text: desktop },
            { area: "All installs", text: "The sidebar draws faster." },
            { area: "CLI and desktop", text: desktop },
            { area: "Self-host", text: tokens },
            { area: "Self-host", text: updates },
            { area: "All installs", text: skills },
          ],
        });
        const checkUpdates =
          repos.merged[merges.findIndex((merge) => merge.title.includes("#4924"))]!;
        expect(release.stderr).not.toContain(checkUpdates);
        const markdown = yield* fs.readFileString(`${directory}/notes.md`);
        expect(markdown.slice(0, markdown.indexOf("## Install"))).toBe(
          [
            "## Changes since 2.0.0-beta.7",
            "",
            "### All installs",
            "",
            "- The sidebar draws faster.",
            `- ${skills}`,
            "",
            "### CLI and desktop",
            "",
            `- ${desktop}`,
            `- ${desktop}`,
            "",
            "### Self-host",
            "",
            `- ${tokens}`,
            `- ${updates}`,
            "",
            "Not listed: 1 other change.",
            "",
            "",
          ].join("\n"),
        );

        const files = [
          ["darwin", "arm64", `executor-v2-${channel}-mac.yml`],
          ["darwin", "x64", `executor-v2-${channel}-mac.yml`],
          ["linux", "x64", `executor-v2-${channel}-linux.yml`],
          ["linux", "arm64", `executor-v2-${channel}-linux-arm64.yml`],
          ["win32", "x64", `executor-v2-${channel}.yml`],
        ] as const;
        for (const [platform, arch, file] of files) {
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
        const output = path.join(directory, "feed");
        const child = yield* processes.spawn(
          ChildProcess.make(
            "node",
            ["scripts/releases/desktop-feed.ts", path.join(directory, "artifacts"), output, json],
            { stdout: "pipe", stderr: "pipe" },
          ),
        );
        const [log, exitCode] = yield* Effect.all(
          [
            Stream.merge(child.stdout, child.stderr).pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        expect(Number(exitCode), log).toBe(0);
        for (const [, , file] of files) {
          const feed = JSON.parse(yield* fs.readFileString(path.join(output, file)));
          expect(feed.releaseNotes[0], file).toEqual({
            version,
            note: [desktop, "The sidebar draws faster.", desktop, skills].join("\n"),
          });
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "--check says who each note is shown to and why, with the entry for its hash or the files that reach each product, prints its hash, and says how to change it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
        const desktop =
          "The desktop app no longer interrupts you with a dialog when an update is ready; a card in the sidebar shows it, and you can restart to install it from there.";
        const repos = yield* repositories([]);
        const commitAll = (subject: string, body: string) =>
          Effect.gen(function* () {
            yield* git(repos.main, "add", "--all");
            yield* git(repos.main, "commit", "--quiet", "--allow-empty", "-m", subject, "-m", body);
          });
        const write = (file: string, text: string) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(`${repos.main}/${file.slice(0, file.lastIndexOf("/"))}`, {
              recursive: true,
            });
            yield* fs.writeFileString(`${repos.main}/${file}`, text);
          });
        const change =
          "to change that, add an entry with its hash and the products it is for to scripts/releases/note-audiences.ts.";
        const base = yield* git(repos.main, "rev-parse", "HEAD");
        yield* write("apps/hosted/server/src/skills.ts", "skills\n");
        yield* write("apps/local/server/src/skills.ts", "skills\n");
        yield* write("scripts/tool.ts", "tool\n");
        yield* commitAll(
          "Move a notice",
          `Release-note: ${desktop}\nRelease-note: Improvement: The skills page loads faster.`,
        );
        const reached =
          "(Cloud: apps/hosted/server/src/skills.ts; CLI and desktop: apps/local/server/src/skills.ts; Self-host: apps/hosted/server/src/skills.ts)";
        const checked = yield* notes(repos, ["--check", base]);
        expect(checked.exitCode, checked.stdout + checked.stderr).toBe(0);
        expect(checked.stdout).toBe(
          [
            `Release-note accepted: ${desktop}`,
            "  Kind: fix, so Cloud's what's new never leads with it (write Feature: or Improvement: before a note that is one)",
            `  Shown to: CLI and desktop, as scripts/releases/note-audiences.ts says for its hash. By its files this change reaches Cloud, CLI and desktop, Self-host ${reached}.`,
            "  Hash: e393b4780407fa27",
            "Release-note accepted: The skills page loads faster.",
            "  Kind: improvement",
            `  Shown to: Cloud, CLI and desktop, Self-host, the products this change reaches ${reached}.`,
            `  If the users of one of them would not notice it, ${change}`,
            `  Hash: ${hash("The skills page loads faster.")}`,
            'Who a note is for is the writer\'s call: see "Who a note is for" in RELEASING.md.',
            "",
          ].join("\n"),
        );
        expect(hash(desktop)).toBe("e393b4780407fa27");

        const toolBase = yield* git(repos.main, "rev-parse", "HEAD");
        yield* write("scripts/tool.ts", "tool, again\n");
        yield* commitAll("Fix the tool", `Release-note: The tool runs.\nRelease-note: ${desktop}`);
        const tool = yield* notes(repos, ["--check", toolBase]);
        expect(tool.exitCode, tool.stdout + tool.stderr).toBe(0);
        expect(tool.stdout).toContain(
          [
            "Release-note accepted: The tool runs.",
            "  Kind: fix, so Cloud's what's new never leads with it (write Feature: or Improvement: before a note that is one)",
            "  Shown to: no product, since this change touches only scripts, tests, fixtures, documents, CI or tooling, which no product ships.",
            `  If users will notice it, ${change}`,
            `  Hash: ${hash("The tool runs.")}`,
            `Release-note accepted: ${desktop}`,
            "  Kind: fix, so Cloud's what's new never leads with it (write Feature: or Improvement: before a note that is one)",
            "  Shown to: CLI and desktop, as scripts/releases/note-audiences.ts says for its hash. By its files this change reaches no product.",
            "  The entry names CLI and desktop, which this change's files do not reach: keep that only if their users will notice the change.",
            "  Hash: e393b4780407fa27",
          ].join("\n"),
        );

        const portBase = yield* git(repos.main, "rev-parse", "HEAD");
        yield* write("apps/docs/content/guide.mdx", "guide\n");
        yield* commitAll(
          "Port the guide",
          `Release-note: The guide explains approvals.\n\n${portMarker}`,
        );
        const ported = yield* notes(repos, ["--check", portBase]);
        expect(ported.exitCode, ported.stdout + ported.stderr).toBe(0);
        expect(ported.stdout).toContain(
          "  As a port of a public pull request, it is also listed in the public release under Other, with its credit.",
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "every entry of scripts/releases/note-audiences.ts has a hash no other entry has, as --check prints it, and at least one known product, once each",
    () =>
      Effect.gen(function* () {
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const child = yield* processes.spawn(
          ChildProcess.make(
            "node",
            [
              "--input-type=module",
              "--eval",
              "const { noteAudiences } = await import(process.argv[1]); process.stdout.write(JSON.stringify(noteAudiences));",
              path.resolve("scripts/releases/note-audiences.ts"),
            ],
            { stdout: "pipe", stderr: "pipe" },
          ),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        expect(Number(exitCode), stderr).toBe(0);
        const entries: ReadonlyArray<{ hash: string; audience: ReadonlyArray<string> }> =
          JSON.parse(stdout);
        expect(entries.length).toBeGreaterThan(0);
        const hashes = entries.map(({ hash }) => hash);
        expect(hashes.filter((hash, index) => hashes.indexOf(hash) !== index)).toEqual([]);
        for (const { hash, audience } of entries) {
          expect(hash).toMatch(/^[0-9a-f]{16}$/u);
          expect(audience.length, hash).toBeGreaterThan(0);
          expect(new Set(audience).size, hash).toBe(audience.length);
          for (const product of audience)
            expect(["cloud", "local", "self-host"], hash).toContain(product);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "--cloud keeps the ten newest of many long notes, reads them from a checkout of main's whole history without file contents however long before the window the last change was, and refuses a checkout that stops inside the window or grafts or replaces its history",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const long = (number: number) =>
          `Cloud change number ${number} ${"is described at length and ".repeat(9)}ends here.`;
        const repos = yield* repositories([
          {
            title: "Change Cloud long ago (#400)",
            body: "Release-note: An old Cloud note.",
            files: ["apps/hosted/cloud/src/old.ts"],
            date: old.toISOString(),
          },
          ...Array.from({ length: 45 }, (_, index) => ({
            title: `Cloud change ${index + 1} (#${401 + index})`,
            body: `Release-note: ${long(index + 1)}`,
            files: [`apps/hosted/cloud/src/change-${index + 1}.ts`],
          })),
        ]);
        const offline = { main: repos.main, publicRepo: "file:///nonexistent/public" };
        const full = yield* notes(offline, ["--cloud", "-"]);
        expect(full.exitCode, full.stdout + full.stderr).toBe(0);
        expect(
          JSON.parse(full.stdout).notes.map((note: { readonly text: string }) => note.text),
        ).toEqual(Array.from({ length: 10 }, (_, index) => long(45 - index)));

        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-cloud-history-" });
        yield* git(repos.main, "config", "uploadpack.allowFilter", "true");
        const whole = `${directory}/whole`;
        yield* git(
          directory,
          "clone",
          "--quiet",
          "--no-local",
          "--filter=blob:none",
          `file://${repos.main}`,
          whole,
        );
        yield* git(whole, "remote", "set-url", "origin", "file:///nonexistent/main");
        const fromWhole = yield* notes({ ...offline, main: whole }, ["--cloud", "-"]);
        expect(fromWhole.exitCode, fromWhole.stdout + fromWhole.stderr).toBe(0);
        expect(fromWhole.stdout).toBe(full.stdout);

        const refusedBy = (main: string) =>
          notes({ ...offline, main }, ["--cloud", "-"]).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                expect(result.exitCode).not.toBe(0);
                expect(result.stdout).not.toContain('"notes"');
              }),
            ),
            Effect.map((result) => result.stdout + result.stderr),
          );
        const shallow = `${directory}/shallow`;
        yield* git(directory, "clone", "--quiet", "--depth", "1", `file://${repos.main}`, shallow);
        const fromShallow = yield* refusedBy(shallow);
        expect(fromShallow).toContain("holds no commit of main from before");
        expect(fromShallow).toContain("fetch-depth: 0");
        const windowStart = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
        yield* git(shallow, "fetch", "--quiet", `--shallow-since=@${windowStart}`, "origin");
        expect(yield* refusedBy(shallow)).toContain("holds no commit of main from before");

        const grafted = `${directory}/grafted`;
        yield* git(directory, "clone", "--quiet", `file://${repos.main}`, grafted);
        const head = yield* git(grafted, "rev-parse", "HEAD");
        yield* fs.writeFileString(`${grafted}/.git/info/grafts`, `${head}\n`);
        expect(yield* refusedBy(grafted)).toContain("grafts its history");
        const replaced = `${directory}/replaced`;
        yield* git(directory, "clone", "--quiet", `file://${repos.main}`, replaced);
        yield* git(replaced, "replace", "--graft", "HEAD");
        expect(yield* refusedBy(replaced)).toContain("replaces commits");
      }).pipe(Effect.scoped),
  );
});
