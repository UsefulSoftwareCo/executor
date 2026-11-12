---
"@executor-js/mcp": patch
"@executor-js/app-templates": patch
---

Images and audio that app tools return now reach the MCP client as image and audio content
blocks instead of base64 text. When the result of `execute`, `call` or `resume` holds an MCP image
or audio block, each distinct block is sent once after the JSON text, and the JSON keeps
`{ type, mimeType, contentIndex }` in its place. Standard and URL-safe base64 are both accepted. A
screenshot from a remote MCP server behind an app is now something the model can see, and its
bytes no longer count as text twice. The `code-mode` skill, which the `executor` skill every
client receives as MCP instructions points to, says how to see bytes a tool returns in another
shape, such as an email attachment: return them from `execute` as an image block.
