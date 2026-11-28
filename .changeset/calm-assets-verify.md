---
'lens': patch
---

Asset verification now distinguishes incomplete lookups from completed
unverified results, retries failures after a short cache window, and preserves
a recent verified result when refreshes fail.
