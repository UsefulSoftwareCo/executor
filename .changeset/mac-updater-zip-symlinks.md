---
"@executor-js/desktop": patch
---

Fix macOS auto-update. The 1.6.9 update zip was built with a 7-Zip that
expanded the framework symlinks into copies, so the extracted app failed code
signing and Squirrel.Mac silently refused to install it; "Restart to update"
appeared to do nothing. electron-builder is bumped to a release that preserves
symlinks, the publish job now verifies the zip's signature before uploading,
and a rejected install surfaces as "Update failed" instead of leaving the card
untouched.
