---
"@executor-js/react": patch
---

fix: honor prefers-reduced-motion in the shared stylesheet

Adds a `prefers-reduced-motion: reduce` block to the global stylesheet that
caps transition/animation durations to 0.01ms and disables smooth scrolling,
so motion-sensitive users get a stable UI. The loading spinner renders
statically under reduced motion (its meaning is preserved via `role="status"`).
