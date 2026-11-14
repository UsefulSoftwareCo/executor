---
"executor": patch
---

`executor upgrade` on an install from the install script downloads the release again. It checked
the status of GitHub's redirect to each release file instead of following it, so every upgrade
failed with "could not download SHA256SUMS" and changed nothing.
