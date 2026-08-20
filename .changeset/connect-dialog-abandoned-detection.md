---
"@executor-js/react": patch
---

**A detection you walk away from no longer follows you**

The connect dialog stayed mounted after closing, so an in-flight URL detection kept its grip on state the user had left behind. Abandoning a detection that later failed left its error banner waiting in the next open, under an empty search box; abandoning one that later succeeded moved the app to that URL's add flow, whatever the user was doing by then. The dialog now unmounts on close, so the search text, protocol facet, open provider card, and detection all die with it, and a withdrawn detection lands nowhere.
