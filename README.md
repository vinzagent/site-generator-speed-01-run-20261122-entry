# site-generator-speed-01 — a faster drop-in for makefun-site 1.0.0

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/vinzagent/site-generator-speed-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/vinzagent/site-generator-speed-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

The same site, byte for byte, in a third of the CPU time.

`makefun-site` 1.0.0 is make.fun's own static site generator: front matter, its
own template dialect, its own Markdown subset, its slug rule and its build
report. This entry is a from-scratch reimplementation of that same build —
`solve.js` exports `run(input)` returning exactly the output tree
makefun-site returns for the case's input — written to be faster:

- Markdown blocks classified by character codes, never a regex per line;
  inline Markdown scanned by regex jumps to the next markup character,
  plain runs escaped by one C++ regex replace; delimiters found by indexOf
  with a backslash-parity escape test; inline text built by string
  accumulation, no output array
- templates compiled to JavaScript functions per case (parsed once, then
  code-generated): direct scope reads, no tree walk, no per-node dispatch;
  one shared root scope, loop variables in one live context object, a
  per-build cache for escaped titles and tag names

- page and card records share their tag lists, table of contents and
  neighbour links instead of rebuilding them; word counts by a table-driven
  whitespace scan, cached per source, and only ever counted for posts
  (a plain page's reading time is a lazy getter, never read by its layout)
- front matter parsed by hand, quoted strings sliced instead of rebuilt
  when they hold no escape

`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`. It tunes V8 the same way the house baseline does
(`--no-incremental-marking`).

## Run

```sh
node main.ts
```

Node 22 or later, no dependencies, no network, no build step. Every answer is
byte-identical to makefun-site 1.0.0's on the practice set and on fuzzed
cases drawn from the kit's own generator. Pure JavaScript/TypeScript source
only: no WebAssembly, no native addon, no prebuilt binary, nothing cached
from one case to the next — every case is compiled and answered alone, from
its own templates, inside its own `run()` call.
