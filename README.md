# Cancellable / contextual promises

Userland promise patching that propagates an "effect scope" (execution context)
across `.then` chains **and native `async/await`**, with skip-callback
cancellation — plus every experiment and benchmark used to design it.

```
cancellablePromise.js            current implementation ("v4") — see below
demo.html / demo.js              side-by-side demo: naive thenable vs this lib
implementations/01-proxy.js      v1: Proxy + global Promise.prototype.then patch
implementations/02-subclass.js   v2: class ContextPromise extends Promise
implementations/03-single-stamp.js  v3: constructor-as-context stamp + global then patch
implementations/04-v4-sandwich-always.js  v4 with the sandwich on every wrapped hop
test/test.js                     correctness suite (6 cases, incl. interleaved await)
bench/single-process-bench.js    first benchmark: pristine vs patched vs after-uninstall
bench/bench-one.js               one mode, self-baselined vs pristine native
bench/bench-all.js               full matrix, one process per mode
bench/protector-test.js          which mutations invalidate V8's promise fast paths
bench/odoo-boot/                 real-world boot benchmark against Odoo (Playwright)
```

## How to run

```sh
node test/test.js                          # correctness (default lib)
node test/test.js implementations/01-proxy.js
node bench/bench-all.js                    # full microbenchmark matrix (~2 min)
node --expose-gc bench/protector-test.js
node --expose-gc bench/single-process-bench.js cancellablePromise.js
# Odoo boot: see header of bench/odoo-boot/run.js
```

## The problem

Patching `Promise.prototype.then` propagates context through `.then` chains,
but `await p` **never calls `.then`**: the spec's `PromiseResolve(%Promise%, p)`
short-circuits when `Get(p, "constructor")` SameValue-equals the `%Promise%`
intrinsic, going straight to the internal `PerformPromiseThen`. The async
function then resumes with no context (demo "Part B"). Zone.js has the same
limitation — it's why Angular transpiles async/await instead of intercepting it.

Two userland tricks fix it:

1. **Defeat the fast path** — give tracked promises a `constructor` that isn't
   `%Promise%`, forcing the thenable route, which calls our patched `then` with
   the internal `(resolve, reject)` pair.
2. **FIFO microtask sandwich** — calling that internal `resolve` only
   *enqueues* the async function's resumption. Enqueue a `push(ctx)` job
   immediately before invoking the callback and a `pop()` job right after:
   FIFO ordering brackets exactly the jobs the callback enqueues, so the
   resumption observes the right context even with interleaved scopes.

## Implementation history

| version | design | tracked awaitLoop | why superseded |
|---|---|---|---|
| v1 proxy | `new Proxy(Promise)` + global `.then` patch + 2 own props/promise | 8–14x | proxy traps + wrapper closures on every static call; every promise in the page pays |
| v2 subclass | `class ContextPromise extends Promise` | 10x | every creation goes through slow derived-constructor + capability path |
| v3 single-stamp | context object stored AS `constructor` (1 own prop), no Proxy | 7.6x | still patched global `Promise.prototype.then` |
| **v4 (current)** | v3 + patched `then` as an **own property on tracked promises only** — global prototype never touched | 7.6x | untracked promises are fully native, `install()`/`uninstall()` leave no residue |

## Microbenchmark results (node v23.10.0, 100k promises, median of 7)

Ratios vs pristine native measured in the same process before the lib loads.
`floor` = an **empty** `class extends Promise {}` — the cost of merely making
`await` interceptable, with zero context logic.

| mode | awaitLoop | thenChain | fanout | awaitWork (~2.5µs/hop) | rpcTimer |
|---|---|---|---|---|---|
| floor | 4.28x | 9.63x | 4.61x | 0.90x | 1.60x |
| proxy | 8.31x | 31.9x | 19.6x | 1.19x | 3.56x |
| subclass | 10.5x | 15.1x | 4.94x | 1.23x | 1.76x |
| v3 | 7.57x | 6.22x | 3.75x | 1.15x | 2.06x |
| **v4 tracked** | **7.62x** | **6.44x** | **2.95x** | **1.23x** | **1.95x** |
| v4-sand (sandwich on every wrapped hop) | 7.12x | 17.8x | 5.13x | 1.13x | 1.87x |
| **v4 untracked** (lib installed, outside effect) | **1.70x** | **1.37x** | **2.24x** | **1.02x** | **1.20x** |

The await-based scenarios (awaitLoop, awaitWork, rpcTimer) are identical
between v4 and v4-sand: `await` always calls `then` with a (resolve, reject)
pair, so those hops are **always** sandwiched — the heuristic never skips
them. The heuristic only spares single-handler `.then(cb)` links (thenChain
6.3x vs 17.8x, ~0.25µs vs ~0.7µs per hop).

**The physics:** intercepting one `await` costs a minimum of 5 microtask jobs
vs 1 native (thenable job, reaction, sandwich push, resumption, sandwich pop)
— all five are provably unremovable under FIFO ordering. Hence no userland
implementation can reach ~1x on bare-hop microbenchmarks (`floor` proves it);
the budget is met as soon as each hop does ≥~2µs of real work. Engine-level
context (Node `AsyncLocalStorage`, future TC39 `AsyncContext`) is the only way
past this in hot loops — not available in browsers today.

`bench/protector-test.js` findings: any own-property stamp or prototype patch
invalidates V8's promise species protector (then-chains ~1.4x isolate-wide,
await path unaffected); v4's stamps pay that cost but leave the `await` fast
path of untracked promises intact.

## Real-world benchmark: Odoo boot (`bench/odoo-boot/`)

Logged-in boots (admin) of Odoo 19.5a1 enterprise on the
`master-contextual-promise-nby` branch, patch toggled via `localStorage`
against the identical server/bundle/session, alternating arms, fresh page per
boot. Client-side ms = navigation → target element, minus server response time.

| scenario | off | proxy (branch impl) | v4 | patched ops/boot |
|---|---|---|---|---|
| /odoo home menu | 113 | 113 | 124 | ~470 |
| /odoo/apps kanban (10 cycles) | 248 [209–268] | 264 [214–277] | 259 [216–285] | ~1,500 |
| /odoo/settings | 199 | 202 | 205 | ~680 |

**Indistinguishable from no patch.** All arms show the same bimodal jitter;
best-case deltas are ~5–8ms on a ~250ms boot. A page boot only pushes ~500–1,500
promise operations through the patch — at sub-µs overhead each that's ~1ms,
invisible next to rendering and RPC work. The microbenchmark ratios never
materialize because real apps do real work between promise hops.

## Known limitations

- `await` on an untracked native promise (e.g. a bare `fetch()` result or an
  async function's return value) bypasses the patch — context is lost unless
  the value passes through a tracked constructor/static
  (`Promise.resolve(fetch(...))` re-stamps it).
- Tracked promises answer `p.constructor === Promise` with their context
  object, which can confuse code that inspects `constructor`.
- The sandwich is skipped when only one `then` handler is a function
  (user-chain heuristic); native continuations enqueued from such callbacks
  don't inherit context. `await`, `.finally()` and two-handler `.then` are
  always sandwiched. If that edge matters, use
  `implementations/04-v4-sandwich-always.js` (same code, sandwich always on —
  cost measured in the table above).
