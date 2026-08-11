# practice — decisions

**The decision log for this module is `docs/03-DECISION-LOG.md` at the repo
root, and it is the only one.** This file is a pointer, deliberately empty of
content: two logs describing the same decision drift, and the drift always
outlives the change that caused it.

Entries touching `modules/practice`:

| Entry | Subject |
|---|---|
| D-048 | `distractor_misconceptions` is keyed by ORIGINAL option index |
| D-056 | Submission is one transaction, including `learner`'s mastery write |
| D-058 | Every persisted index is the canonical one; the shuffle is presentation-only |
| D-065 | The evidence columns are written on every response and cannot be backfilled |
| D-073, D-091 | The resource tenant is read from the data, never from the actor |
| D-077 | The hint ladder and misconception codes are unauthored in the corpus |
| D-131 | `signals` reuses this module's anti-cheat floor and verdict, never a copy |
| **D-188** | Rule 2 reads the PRESENTATION index — it was judging the answer key |
| **D-189** | Rule 1 clamps the claimed total to real elapsed time (the backstop the contract claimed) |
| **D-190** | Both anti-cheat thresholds are now pinned to literals in this module |
| **D-191** | The write paths have their own access tests |
| **D-192** | The per-question shuffle map is tested with maps that genuinely differ |
| **D-241** | The mastery step is a compare-and-set — the read-modify-write was a lost update |
| **D-242** | A per-student advisory lock, taken first in the transaction, closes the daily XP cap |
| **D-246** | Concurrency is proved with a barrier on an injected seam, not with two awaits |
| **D-247** | Two silent truncations remain here (`limit: 200`, `limit: 100`) — needs a product decision |
