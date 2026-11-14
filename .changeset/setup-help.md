---
"apps": patch
"@executor-js/sdk": patch
"@executor-js/ui": patch
"@executor-js/hosted-server": patch
"@executor-js/local-server": patch
"@executor-js/app-templates": patch
---

Apps can tell people where to get credentials. `string()`, `number()` and
`boolean()` take `{ title, description }`, `secrets()` takes a `guide` and
`oauth2()` a `clientGuide`. The connect form shows a field's `title` as its label
and its description under the input as Markdown, a method's guide in place of
the generic "Get these credentials" line, and the client guide after the
redirect URL during OAuth client entry. This setup help is not part of the
provider ID or the stored provider definition, so editing it keeps accounts
connected and two apps that explain one provider differently share accounts. A
deploy fails with `VersionBuildFailed` when help has raw HTML, an image or a link
that is not an absolute https URL, or when a guide is over 4,000 characters or a
field description over 1,000. Rendered app Markdown, tool descriptions included,
now links only https URLs and shows images as their alt text. Hosts pass
`createExecutor` a `markdown` reader, `markdownRefusals` from
`@executor-js/sdk/markdown`, which parses that help. A reader that parses
elsewhere fails with `MarkdownUnavailable` (503, retryable) when it gets no
answer, and so does the deploy; nothing is saved unchecked. The app-authoring
skill documents it.
