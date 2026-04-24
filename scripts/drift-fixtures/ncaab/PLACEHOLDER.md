# NCAAB drift fixtures — intentionally empty

NCAAB has no isolated engine module today. Its surfacing math (probability
penalty for derived lines, ELITE/STRONG/LEAN/NO_EDGE tiering) lives inline
in `server/routes.ts` around line 513.

Once an `server/engines/ncaab/index.ts` module exists with a pure
`processNCAABEngine(candidates)` entry point, drop fixture JSON files into
this directory and `scripts/drift-check.mjs` will start asserting on them
automatically (just add the `ncaab` entry to the `SPORTS` array).

This placeholder file is committed so the directory exists and is discoverable.
