/**
 * What GitHub itself makes of a release's notes. `scripts/releases/release-notes.ts` accepts a note
 * only when it is plain prose (an allow-list) and prints it as written, so these cases send what it
 * writes to GitHub's Markdown API (`POST /markdown`, GFM, in the public repository's context, as a
 * release body is rendered) and read the HTML back: every accepted note must come back as its text
 * alone. The refused notes go too, to show that what the check looks for is what GitHub makes of
 * them. It needs a token in GH_TOKEN (CI passes the job's own); rendering needs no permission.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, Layer, Schedule } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import {
  acceptedNotes,
  notes,
  portMarker,
  portTrailers,
  refusedNotes,
  repositories,
} from "../release-notes-repositories.ts";

const render = (text: string) =>
  Effect.gen(function* () {
    // The job's token in CI, or any gh login's locally (`GH_TOKEN=$(gh auth token)`).
    const token = yield* Config.Redacted("GH_TOKEN").pipe(
      Config.orElse(() => Config.Redacted("GITHUB_TOKEN")),
    );
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({ schedule: Schedule.exponential(2_000), times: 3 }),
    );
    const request = yield* HttpClientRequest.post("https://api.github.com/markdown").pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders({
        Accept: "application/vnd.github+json",
        "User-Agent": "executor-release-notes-spec",
        "X-GitHub-Api-Version": "2022-11-28",
      }),
      HttpClientRequest.bodyJson({ text, mode: "gfm", context: "UsefulSoftwareCo/executor" }),
    );
    const response = yield* http.execute(request);
    return yield* response.text;
  });

/** The list items of rendered HTML, as HTML. */
const items = (html: string) =>
  [...html.matchAll(/<li>([\s\S]*?)<\/li>/gu)].map((match) => match[1]!);

/** Text from HTML that holds no element. */
const text = (html: string) =>
  html
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/gu, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&amp;/gu, "&");

/** The only elements the notes' own Markdown makes: their headings, the list and a paragraph. */
const structure = new Set([
  '<h2 dir="auto">',
  "</h2>",
  '<h3 dir="auto">',
  "</h3>",
  '<ul dir="auto">',
  "</ul>",
  "<li>",
  "</li>",
  '<p dir="auto">',
  "</p>",
]);

/** The credit the notes give a port, as GitHub renders it: the public pull request and a handle. */
const credit =
  / \(<a href="https:\/\/github\.com\/UsefulSoftwareCo\/executor\/pull\/2436"[^>]*>#2436<\/a>, thanks <a class="user-mention notranslate"[^>]*href="https:\/\/github\.com\/danizord">@danizord<\/a>\)$/u;

const portNote = "A self-hosted Executor limits each client behind trusted proxies on its own.";

/**
 * Messages whose only `<` and `[` are on whole `Co-authored-by:` lines in their middle, as a squash
 * joins a port's commits, in the shapes that still match the script's strict pattern but could make
 * Markdown out of the trailer: names of dashes or equals signs (a setext underline), emphasis, a
 * table's pipes, an entity, a closing backslash, a local part and host of hyphens, a bot with
 * trailing spaces (a hard break), and a trailer right above or below its note with no blank line
 * between, where Markdown joins them into one paragraph. Each `note` must be listed by the script,
 * and each line of `shown` must render as text in a plain paragraph, so no trailer can hide, quote,
 * indent or swallow what follows it.
 */
const trailerProbes: ReadonlyArray<{ readonly body: string; readonly note: string }> = [
  {
    note: "A note after a trailer line in the middle is shown.",
    body: "Some prose about the change.\n\nCo-authored-by: Someone <someone@example.invalid>\n\nRelease-note: NOTE\n\nThe rest of the message.",
  },
  {
    note: "A note right under a trailer of dashes is shown.",
    body: "Co-authored-by: --- <a@example.invalid>\nRelease-note: NOTE\nThe rest of the message.",
  },
  {
    note: "A note right over a trailer of equals signs is shown.",
    body: "Some prose.\n\nRelease-note: NOTE\nCo-authored-by: === <a@example.invalid>\nThe rest of the message.",
  },
  {
    note: "A note under a trailer of dashes after a blank line is shown.",
    body: "Co-authored-by: ---------- <a@example.invalid>\n\nRelease-note: NOTE\n\nThe rest of the message.",
  },
  {
    note: "A note under an address of hyphens is shown.",
    body: "Co-authored-by: Someone <---@--->\nRelease-note: NOTE\nThe rest of the message.",
  },
  {
    note: "A note under a bot with trailing spaces is shown.",
    body: "CO-AUTHORED-BY: helper[bot] <1+helper[bot]@users.noreply.github.com>   \nRelease-note: NOTE\nThe rest of the message.",
  },
  {
    note: "A note under a trailer of emphasis marks is shown.",
    body: "Co-authored-by: *** ___ ** <a@example.invalid>\nRelease-note: NOTE\nThe rest of the message.",
  },
  {
    note: "A note under a trailer of pipes is shown.",
    body: "Co-authored-by: a | b | <a@example.invalid>\nRelease-note: NOTE\nThe rest of the message.",
  },
  {
    note: "A note under a trailer with an entity is shown.",
    body: "Co-authored-by: &lt;!-- <a@example.invalid>\nRelease-note: NOTE\nThe rest of the message.",
  },
  {
    note: "A note under a trailer ending in a backslash is shown.",
    body: "Co-authored-by: x \\ <a@example.invalid>\nRelease-note: NOTE\nThe rest of the message.",
  },
].map(({ note, body }) => ({ note, body: body.replace("NOTE", note) }));

/** Void elements, which open nothing. */
const voidElements = new Set(["br", "hr", "img", "input", "wbr"]);

/** The elements open in rendered HTML where `at` starts, outermost first. */
const openAt = (html: string, at: number) => {
  const open: Array<string> = [];
  for (const match of html.slice(0, at).matchAll(/<(\/?)([A-Za-z][A-Za-z0-9-]*)[^>]*?(\/?)>/gu)) {
    const [, closing, name = "", selfClosing] = match;
    const tag = name.toLowerCase();
    if (closing === "/") {
      const index = open.lastIndexOf(tag);
      if (index >= 0) open.splice(index);
    } else if (selfClosing !== "/" && !voidElements.has(tag)) open.push(tag);
  }
  return open;
};

layer(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer), { excludeTestServices: true })(
  "Release notes on GitHub",
  (it) => {
    it.effect(
      "GitHub renders every accepted note, in the notes built from them, as its text alone",
      () =>
        Effect.gen(function* () {
          const repos = yield* repositories([
            {
              title: "Write plain notes (#210)",
              body: acceptedNotes.map((note) => `Release-note: ${note}`).join("\n"),
              files: ["packages/sdk/src/plain.ts"],
            },
            {
              title: "Rate-limit each self-host client behind trusted proxies (#112)",
              body: `Release-note: ${portNote}\n\n${portMarker}\n\n${portTrailers}`,
              files: ["apps/hosted/self-host/src/limit.ts"],
            },
          ]);
          const result = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
          expect(result.exitCode, result.stderr).toBe(0);
          // What follows is the README's install section, which no commit writes.
          const [changes = ""] = result.stdout.split("\n## Install\n");
          const html = yield* render(changes);
          const listed = items(html);
          expect(listed).toHaveLength(acceptedNotes.length + 1);
          for (const [index, note] of acceptedNotes.entries()) {
            expect(listed[index], note).not.toContain("<");
            expect(text(listed[index]!), note).toBe(note);
          }
          // The port's line: its note as text, then the credit the script writes, and nothing else.
          const port = listed.at(-1)!;
          expect(port, port).toMatch(credit);
          expect(text(port.replace(credit, ""))).toBe(portNote);
          // Outside the items, nothing but the headings, the list and its paragraph.
          const outside = html.replace(/<li>[\s\S]*?<\/li>/gu, "<li></li>");
          for (const [tag] of outside.matchAll(/<[^>]*>/gu)) expect(structure, tag).toContain(tag);
        }),
    );

    it.effect(
      "a whole co-author trailer line in a message's middle leaves its note listed, and hides, quotes, indents or swallows no line after it",
      () =>
        Effect.gen(function* () {
          const repos = yield* repositories(
            trailerProbes.map(({ body }, index) => ({
              title: `Probe a trailer line (#${600 + index})`,
              body,
              files: [`packages/sdk/src/trailer-probe-${index}.ts`],
            })),
          );
          const result = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
          expect(result.exitCode, result.stderr).toBe(0);
          expect(result.stderr).not.toContain("::warning");
          const [changes = ""] = result.stdout.split("\n## Install\n");
          expect(changes.trim()).toBe(
            [
              "## Changes since 2.0.0-beta.4",
              "",
              "### All installs",
              "",
              ...trailerProbes.map(({ note }) => `- ${note}`),
            ].join("\n"),
          );
          for (const { body, note } of trailerProbes) {
            const html = yield* render(body);
            yield* Console.log(`${JSON.stringify(body)}\n  -> ${JSON.stringify(html)}`);
            for (const line of [`Release-note: ${note}`, "The rest of the message."]) {
              const at = html.indexOf(line);
              expect(at, `${line} in ${html}`).toBeGreaterThanOrEqual(0);
              expect(openAt(html, at), `${line} in ${html}`).toEqual(["p"]);
            }
            expect(html, body).not.toMatch(/<(?:pre|code|blockquote|h[1-6]|table|details)\b/u);
          }
        }),
    );

    it.effect("GitHub renders what the notes refuse as links, mentions, images or markup", () =>
      Effect.gen(function* () {
        const html = yield* render(refusedNotes.map(({ note }) => `- ${note}`).join("\n"));
        const rendered = items(html);
        expect(rendered).toHaveLength(refusedNotes.length);
        const active = new Set(
          refusedNotes.flatMap(({ note }, index) => (rendered[index]!.includes("<") ? [note] : [])),
        );
        for (const { note, reason } of refusedNotes)
          yield* Console.log(
            `${active.has(note) ? "active" : "inert "}  ${JSON.stringify(note)}  (${reason})`,
          );
        // The values review found GitHub turning into a mention, a reference, a link or an emoji,
        // and the earlier review's links, image, HTML, emphasis, URLs and heading.
        for (const note of [
          "\\@someone",
          "gh-123 is fixed",
          "HTTP://example.invalid",
          "UsefulSoftwareCo/executor#123",
          "@one@two",
          "#1#2",
          ":shipit:",
          "See [the guide](https://evil.example/guide)",
          "Logo ![logo](https://evil.example/a.png)",
          "Look <img src=x onerror=alert(1)>",
          "Now **bold**",
          "Read https://evil.example/bare",
          "Visit www.example.com",
          "# Executor starts faster",
          "Run `executor upgrade`",
        ])
          expect(active, note).toContain(note);
      }),
    );
  },
);
