/**
 * Markdown written for people connecting an account: the setup help apps write, a secrets method's
 * `guide`, an OAuth method's `clientGuide` and each field's `description` (see `withoutHelp` in
 * `apps/contracts`). The connect form renders it as Markdown, so the host refuses what the form
 * would not show safely: links other than absolute https URLs, raw HTML and images. The host's
 * `MarkdownReader` parses it, all of a deploy's help in one read.
 */
import { Array as Arr, Effect } from "effect";
import { fieldDescriptions, helpTextLimits } from "apps/contracts";
import type {
  MarkdownReader,
  MarkdownRefusals,
  MarkdownUnavailable,
} from "../contracts/markdown.ts";
import type { ProviderDefinition } from "../contracts/provider.ts";

const count = (value: number) => value.toLocaleString("en-US");

/** One piece of setup help, and where it was written, such as `method "apiKey" guide`. */
export interface HelpText {
  readonly where: string;
  readonly text: string;
  readonly maxLength: number;
}

/**
 * Each piece paired with what the reader found in it, in one read. Nothing to read calls no reader.
 * A reader that does not answer every text is a defect, so no piece goes unchecked.
 */
const readEach = <A extends { readonly text: string }>(
  markdown: MarkdownReader,
  pieces: ReadonlyArray<A>,
): Effect.Effect<ReadonlyArray<readonly [A, MarkdownRefusals]>, MarkdownUnavailable> =>
  pieces.length === 0
    ? Effect.succeed([])
    : Effect.flatMap(markdown(pieces.map(({ text }) => text)), (refusals) =>
        refusals.length === pieces.length
          ? Effect.succeed(Arr.zip(pieces, refusals))
          : Effect.die(
              new Error(
                `The Markdown reader answered ${refusals.length} of ${pieces.length} texts`,
              ),
            ),
      );

/** Every piece of setup help in a provider definition, each naming its method and field. */
export const setupHelp = (definition: ProviderDefinition): ReadonlyArray<HelpText> =>
  Object.entries(definition.auth).flatMap(([name, method]) => {
    const [guide, text, fields] =
      method.type === "secrets"
        ? ["guide", method.guide, method.fields]
        : ["clientGuide", method.clientGuide, method.response];
    return [
      ...(text === undefined
        ? []
        : [{ where: `method "${name}" ${guide}`, text, maxLength: helpTextLimits.guide }]),
      ...fieldDescriptions(fields).map(([field, description]) => ({
        where: `method "${name}" field "${field}" description`,
        text: description,
        maxLength: helpTextLimits.description,
      })),
    ];
  });

/** What is wrong with each piece of help, each naming where it was written; nothing when none is. */
export const setupHelpProblems = (markdown: MarkdownReader, help: ReadonlyArray<HelpText>) =>
  Effect.map(readEach(markdown, help), (read): ReadonlyArray<string> =>
    read.flatMap(([{ where, text, maxLength }, refused]) =>
      [
        ...(text.length > maxLength
          ? [`is ${count(text.length)} characters; the limit is ${count(maxLength)}`]
          : []),
        ...(refused.html ? ["contains raw HTML; write Markdown instead"] : []),
        ...(refused.image
          ? ["contains an image; images are not shown, so link to the page instead"]
          : []),
        // The address is not quoted: help can hold private URLs, and errors never repeat them.
        ...(refused.links.length > 0
          ? ["has a link whose address does not start with https://"]
          : []),
      ].map((problem) => `${where} ${problem}`),
    ),
  );
