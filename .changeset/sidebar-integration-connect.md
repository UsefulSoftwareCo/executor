---
"executor": patch
---

**Connect an integration from the sidebar**

The sidebar lists your integrations on every console route, but connecting
another one meant navigating back to the integrations page to reach its Connect
action — the picker state was owned by that page, so the shared shell could
render the list without being able to open the flow behind it.

The connect dialog now belongs to the shell. A labelled plus button sits beside
the sidebar's Integrations heading and opens the same picker, records the same
event, and leaves the current route in place behind it. On mobile the navigation
drawer closes first so the dialog gets the full viewport.
