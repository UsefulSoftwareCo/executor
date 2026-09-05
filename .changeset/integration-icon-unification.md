---
"executor": patch
"@executor-js/plugin-mcp": patch
---

Show real icons on the integration browse page. The Codex plugin preset cards
rendered a bare-letter avatar: the page fed the preset's authenticated
`executor:` icon path into a raw `<img>`, which can never load it, and never
consulted the preset's public fallback image. Icon rendering is now unified on
one component — explicit icon, then its fallback image, then the favicon
derived from the integration's URL, then a neutral mark — used by the browse
cards, the command palette, and the Codex plugin add screen alike.
