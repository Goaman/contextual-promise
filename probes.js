// The one and only probe suite: the exact checks the demo page (index.js)
// renders, the correctness runner (test/test.js) asserts, AND the hover-source
// tooltips display. Each part is a function of the uniform env every impl
// exposes on window — { effect, getCurrent, rpc } — so the three consumers can
// never drift apart. rpc defaults to Promise.resolve; the naive strategy
// supplies its own bespoke thenable.
//
// Wrapped in an IIFE so that, when loaded as a classic <script> alongside
// scenarios.js on the same page, its internals don't leak into (or collide in)
// the shared global lexical scope — only the explicit window exports escape.
(function () {
const PARTS = {
    // PART A: does each scope's `.then()` continuation see its own scope?
    async A({ effect, getCurrent, rpc }) {
        const seen = {};
        const a = effect('S1', () => rpc().then(() => (seen.S1 = getCurrent())));
        const b = effect('S2', () => rpc().then(() => (seen.S2 = getCurrent())));
        await Promise.all([a, b]);
        return seen; // expect: { S1: 'S1', S2: 'S2' }
    },

    // PART B: same, through native async/await instead of `.then()`.
    async B({ effect, getCurrent, rpc }) {
        const seen = {};
        const a = effect('S1', () => (async () => { await rpc(); seen.S1 = getCurrent(); })());
        const b = effect('S2', () => (async () => { await rpc(); seen.S2 = getCurrent(); })());
        await Promise.all([a, b]);
        return seen; // expect: { S1: 'S1', S2: 'S2' }
    },

    // PART C: does context survive ONE layer of async composition? blip() is an
    // async fn; nestBare() awaits its result. blip()'s promise is a NATIVE
    // %Promise% (async fns always use the intrinsic), so stamp-based
    // interception never triggers... but the await's Get(value, "constructor")
    // IS observable, and 05-constructor-trap intercepts it with a prototype
    // accessor that captures the awaiter's context at the suspension point —
    // bare composition works there. For the stamp-only impls, re-stamping the
    // intermediate through a tracked constructor (`Promise.resolve(blip())`)
    // hands them a promise they own, so they restore context around the resume;
    // naive can't (it only tracks its bespoke thenable).
    async C({ effect, getCurrent, rpc }) {
        async function blip() { await rpc(); return getCurrent(); }
        async function nestBare() { await blip(); return getCurrent(); }
        async function nestRestamp() { await Promise.resolve(blip()); return getCurrent(); }
        return {
            Cbare: await effect('CTX', () => nestBare()),         // v5 only
            Crestamp: await effect('CTX', () => nestRestamp()),   // any patched impl
        };
    },

    // PART D: the flip side of C — awaiting a SCOPED promise from OUTSIDE any
    // scope. Resolver-side designs (the naive thenable and stamp impls v1-v4)
    // restore the promise's CREATION scope around whoever awaits it, so the
    // scope leaks into an awaiter that never entered it (transiently: the next
    // bare native await cuts the chain). Awaiter-side capture (v5) resumes
    // out-of-scope awaiters natively: clean. `null` == no leak.
    async D({ effect, getCurrent, rpc }) {
        await effect('S1', () => rpc());
        const leaked = getCurrent();
        return leaked === undefined ? null : leaked;
    },

    // PART E: ONE shared promise — a "ready" signal, or a deduped in-flight
    // request — awaited by TWO different scopes at once. A shared promise has a
    // SINGLE identity, so which scope does each continuation resume in?
    //   - Resolver-side designs (naive, stamps v1-v4) can only bracket the
    //     resumptions with the promise's ONE creation context (here: none — it
    //     was made outside any scope), so both awaiters see the same wrong scope.
    //   - Awaiter-side v5 records context per-await, but into a SINGLE pending
    //     slot on the promise: the second `await` overwrites the first, so the
    //     resume that fires first wins the (now shared) slot and the other falls
    //     back to the creation context. v5 documents this as a known limitation.
    // So NO impl currently returns the correct { A: 'A', B: 'B' } — this probe
    // exists to show exactly what each one *does* return (e.g. A saw B, B saw
    // undefined). Fixing it needs a per-promise queue of awaiter contexts.
    async E({ effect, getCurrent, rpc }) {
        const shared = rpc(); // created OUTSIDE any scope; awaited by both below
        const seen = {};
        async function consumer(name) {
            await shared;              // A and B await the SAME promise
            seen[name] = getCurrent(); // which scope does each continuation see?
        }
        await Promise.all([
            effect('A', () => consumer('A')),
            effect('B', () => consumer('B')),
        ]);
        return seen; // ideal: { A: 'A', B: 'B' } — no impl achieves this yet
    },
};

// Run every part against `env` and flatten C into { Cbare, Crestamp }.
async function runProbes(env) {
    const e = {
        effect: env.effect,
        getCurrent: env.getCurrent,
        rpc: env.rpc || (() => Promise.resolve()),
    };
    const A = await PARTS.A(e);
    const B = await PARTS.B(e);
    const C = await PARTS.C(e);
    const D = await PARTS.D(e);
    const E = await PARTS.E(e);
    return { A, B, Cbare: C.Cbare, Crestamp: C.Crestamp, D, E };
}

// Dual-target export: Node (test/test.js) via require, browser (index.js and
// its iframe) via window globals. `typeof` guards keep both environments happy.
const api = { runProbes, PARTS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') { window.runProbes = runProbes; window.Probes = api; }
})();
