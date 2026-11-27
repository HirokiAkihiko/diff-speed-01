# diff-speed-01

A faster drop-in for makefun-diff 1.0.0, built for the make.fun bounty
"Diff two texts faster" (diff-speed-01-run-20261126).

`solve.js` exports `run(input)`, which returns exactly makefun-diff's
patch of `{ old, new }` — same header, same hunks, same tie-breaks —
and `main.ts` is the harness driver: it reads `/input/cases.json`,
answers each case with `run`, and writes `/output/answers.json`.

Speed comes from two exact shortcuts, not from a different algorithm:

1. Lines are interned to integers before the search, so Myers compares
   ints instead of strings.
2. The search is pruned to the diagonals that can still reach the end
   within a budget U. U is the cost of a script built from the lines
   that occur exactly once in each text (their longest increasing
   subsequence as anchors, exact LCS cost per segment between them).
   The pruned search returns exactly the unpruned search's script; if
   it cannot finish by U, the plain search runs instead.

On the kit's practice set it runs about 5–6x faster than the house
baseline, with byte-identical answers on the practice set and on
thousands of fuzzed cases (including `\r` inside lines and a last line
with no trailing newline).

MIT licensed.
