---
"executor": patch
---

**A console URL naming an organization you cannot see is a not-found page, every time**

Opening `/<some-other-slug>/policies` sometimes rendered the full authenticated console — sidebar, org switcher showing your OWN organization, page chrome — under an address naming an organization you are not a member of. The page body was a failing org-scoped query with a Retry button, so the workspace on screen belonged to nobody and the URL belonged to someone else.

The shell's not-found only fired once `/account/me` had answered for the URL's slug. Until then the console read its identity from the auth-hint cookie, which always names the organization the session last landed in, never the one in the address bar. So the first paint answered a question about a different organization and built a whole workspace out of it, and whether you ever saw that depended on how fast the server replied.

The shell is now built only from an answer that names the organization the URL names. A slug the current answer does not cover renders nothing at all until `/account/me` resolves for that slug, and then either the workspace or — for an organization this session cannot see — the not-found page. The URL is never rewritten: a wrong address stays a wrong address.

The ordinary cold load is untouched. The hint names the slug already in the URL, so it matches on the very first paint and the shell renders with no round trip. Only a slug the hint does not name waits: a foreign one, and the single frame after switching organizations, which now paints the organization the URL asked for instead of briefly showing the previous one.
