# OpenAPI conversion reference hook

`effect@c7d1ffff.patch` adds an optional `onReference` callback to Effect's
OpenAPI 3.0 and 3.1 schema converters. The existing converters own traversal.
The callback receives original reference strings before rewriting. It does not
follow targets, visit examples or defaults, or visit ignored 3.0 ref siblings.
The default conversion is unchanged, and callback exceptions propagate.

Executor uses the hook to collect reachable components while converting them.
This removes its separate schema walker and keeps recursive references finite.
The document adapter also uses Effect's public JSON Pointer parser for both
object and schema references.

The patch contains the source change and its published JavaScript and types.
It is local to the pinned Effect dependency; it has not been submitted upstream.
An upstream proposal needs only the source change and contract cases for the
callback in Effect's test harness. Remove the patch when an Effect release provides the hook.
