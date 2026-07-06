# Cancellable / contextual promises

Userland promise patching that propagates an "effect scope" (execution context)
across `.then` chains **and native `async/await`**, with skip-callback
cancellation — plus every experiment and benchmark used to design it.

```
demo.html / demo.js              side-by-side demo: runs every implementation below
implementations/00-original.js   stamp-based implementation ("v4") — see below
implementations/05-constructor-trap.js  current ("v5"): v4 + awaiter-side constructor trap — bare `await` works
implementations/naive.js         naive userland thenable (no Promise patch) — the strawman
implementations/01-proxy.js      v1: Proxy + global Promise.prototype.then patch
implementations/02-subclass.js   v2: class ContextPromise extends Promise
implementations/03-single-stamp.js  v3: constructor-as-context stamp + global then patch
implementations/04-v4-sandwich-always.js  v4 with the sandwich on every wrapped hop
test/test.js                     correctness suite (7 cases, incl. interleaved & bare-composition await)
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
node --expose-gc bench/single-process-bench.js implementations/00-original.js
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

## The second wall — and why it isn't one (v5)

Stamps only exist on promises that pass through a tracked constructor. An
async function's implicit promise is allocated **inside the engine**, so a
bare `await blip()` sees the inherited `constructor === %Promise%` via the
prototype and takes the internal fast path: one layer of async composition
loses the context (demo Part C). This looked like a hard userland wall.

It isn't, because the fast-path check itself is observable. In V8
(`src/builtins/builtins-async-gen.cc`, `Await`): the `"constructor"` lookup on
the awaited value is skipped **only while** the value's `[[Prototype]]` is the
initial `Promise.prototype` *and the promise `@@species` protector is intact*
— and our own-property stamps invalidate that protector anyway. Once it's
gone, **every `await` performs a real, observable `Get(value,
"constructor")`**, which reaches `Promise.prototype.constructor` — a plain,
replaceable data property.

v5 (`implementations/05-constructor-trap.js`) replaces it with an accessor:

3. **Constructor trap** — the getter runs *synchronously inside `Await`*, with
   `this` = the awaited promise, while the **awaiter's** context is still on
   the exec stack — exactly the moment and identity the stamps couldn't reach.
   Context ambient? Record it on the promise, stamp an own `then`, return the
   context object (SameValue fails → V8 allocates the wrapper and calls
   `ResolvePromise`, whose `"then"` lookup is also observable once the
   then-protector is gone — `src/builtins/promise-resolve.tq`, label `Slow` —
   and finds our `then`; the usual sandwich brackets the resumption). No
   context ambient? Return `%Promise%` — the await stays fully native.

The trap also *fixes the semantics*: v4's await interception is
**resolver-side** (the resumption inherits the context stored on the awaited
promise, so awaiting a scoped promise from outside a scope briefly infects
the awaiter — observable in v4 as a transient context leak that dies at the
next bare native await). The trap captures the context ambient **at the
suspension point**, i.e. the awaiter's own scope — the same semantics as
`AsyncLocalStorage` / TC39 `AsyncContext`. Awaits resume in the awaiter's
scope; `.then(cb)` callbacks keep the promise's creation scope (what
skip-callback cancellation wants).

## Implementation history

| version | design | tracked awaitLoop | why superseded |
|---|---|---|---|
| v1 proxy | `new Proxy(Promise)` + global `.then` patch + 2 own props/promise | 8–14x | proxy traps + wrapper closures on every static call; every promise in the page pays |
| v2 subclass | `class ContextPromise extends Promise` | 10x | every creation goes through slow derived-constructor + capability path |
| v3 single-stamp | context object stored AS `constructor` (1 own prop), no Proxy | 7.6x | still patched global `Promise.prototype.then` |
| v4 | v3 + patched `then` as an **own property on tracked promises only** — global prototype never touched | 7.6x | bare `await` on engine-created promises (async fn results, `fetch()`) loses context; resolver-side await semantics leak scopes into outside awaiters |
| **v5 (current)** | v4 + `Promise.prototype.constructor` accessor capturing the **awaiter's** context at the suspension point | ~v4 (8.8x vs same-run v4 7.9x) | — (cost: the getter fires on every constructor lookup isolate-wide; untracked bare hops ~+35% vs v4) |

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
| v5-trap tracked ¹ | 8.84x | 6.98x | 3.85x | 1.19x | 3.44x |
| v5-trap untracked ¹ | 2.78x | 2.60x | 2.95x | 0.98x | 1.58x |

¹ v5 rows are from a later, noisier run (its native control read 0.77–1.86x);
same-run v4 measured 7.94x/7.27x tracked and 2.06x/1.86x untracked on
awaitLoop/thenChain. Net: tracked cost is v4-level; **untracked bare hops pay
~+35%** — the constructor-trap getter fires on every await/species lookup
isolate-wide, which is exactly the residue v4 was designed to avoid. awaitWork
(~2.5µs of real work per hop) stays at ~1x in both.

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
path of untracked promises intact. v5 spends that residue instead of avoiding
it: with the species protector dead, V8's `Await` must perform the observable
constructor `Get` on **every** await, and v5's prototype accessor answers it —
`%Promise%` outside scopes (native resume), the ambient context inside them.

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

v4 (`00-original.js`):

- `await` on an untracked native promise (e.g. a bare `fetch()` result or an
  async function's return value) bypasses the patch — context is lost unless
  the value passes through a tracked constructor/static
  (`Promise.resolve(fetch(...))` re-stamps it). **Solved by v5.**
- Await semantics are resolver-side: awaiting a scoped promise from outside
  any scope runs the awaiter's continuation in the *promise's* scope until the
  next bare native await cuts the chain (transient leak — demo Part D).
  **Solved by v5** (awaiter-side capture; out-of-scope awaits stay native).
- Tracked promises answer `p.constructor === Promise` with their context
  object, which can confuse code that inspects `constructor`.

v5 (`05-constructor-trap.js`):

- `p.constructor === Promise` is `false` when evaluated *inside* an active
  scope (the accessor answers with the context object; outside scopes it
  answers `%Promise%` — better than v4's stamped-forever answer). Reading
  `constructor` inside a scope also marks the promise's next two-handler
  `then` as await-like (single pending slot, see the source header).
- Two different scopes awaiting the *same* promise in the same synchronous
  burst share the single pending-context slot — the later capture wins for
  both resumptions.
- `uninstall()` restores `Promise.prototype.constructor` but cannot restore
  V8's protectors — bare hops keep the observable-lookup cost until reload
  (v4 has the same protector residue once anything was stamped).

Both:

- The sandwich is skipped when only one `then` handler is a function
  (user-chain heuristic); native continuations enqueued from such callbacks
  don't inherit context. `await`, `.finally()` and two-handler `.then` are
  always sandwiched. If that edge matters, use
  `implementations/04-v4-sandwich-always.js` (same code, sandwich always on —
  cost measured in the table above).
