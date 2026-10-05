# Pikafish WebAssembly source notice

The files served from `/js/worker/pikafish-engine.js`,
`/js/worker/pikafish-engine.wasm`, and `/nnue/pikafish-9e20a9a44415.nnue`
were built and distributed by Chinese-Chess-AI-Pro at commit:

`00ac398c8867c22d638630f8752e7a5ad8f98aca`

Exact corresponding source:

https://github.com/billzi2016/Chinese-Chess-AI-Pro/tree/00ac398c8867c22d638630f8752e7a5ad8f98aca

Upstream Pikafish source:

https://github.com/official-pikafish/Pikafish

Pikafish is licensed under GNU GPL version 3. See `Copying.txt` in this
directory. The NNUE weights have additional usage terms in the upstream
Pikafish README, including legal-use and commercial-use restrictions.

## Local modifications

`pikafish-engine.js` was modified in this project (GPL-3.0 permits this; the
change is recorded here as required). Only the message-handling glue was
touched, the Emscripten/engine code is unchanged:

- `parseUciInfoLine` also extracts `multipv` and `pv`.
- Each `info ... pv` line is forwarded as a `PV` message (`{depth, multipv,
  score, mate, pv}`) so the page can read the top-N candidate moves.
- `SEARCH` accepts `multipv`, `depth` and `nodes`; it sends
  `setoption name MultiPV` and uses `go depth` / `go nodes` when given,
  otherwise `go movetime` as before.

Original upstream SHA-256 of `pikafish-engine.js`:
`2e663e85256fe6cbf83edee973e9e1c678b8e458b95c588c2c54451726d60c41`

Bundled file SHA-256 checksums:

- `pikafish-engine.js` (modified): `b4bcf2b1a266757ab2b2c78d6571f7a6c39f64858b9d660ebcba42b10377403a`
- `pikafish-engine.wasm`: `56159745c701f2a10c30cd1e585d04c03e90809dbf4d486eeeab94806e7aa120`
- `pikafish-9e20a9a44415.nnue`: `3cd15292bf8c979884262f57fc723959fc0dea43b4d8d544f88db5ceb2479e24`
