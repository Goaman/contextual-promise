// The benchmark scenarios, defined exactly once. Each takes the promise
// constructor `P`, an `effectFn` wrapper, the sizes `N` / `N_RPC`, and the
// CPU-burn helper `work`, and returns the promise the timing loop awaits.
//
// Consumed by:
//   - bench/bench-one.js — via require(), run in Node
//   - index.js — loaded as a <script> in each bench iframe (executed there) and
//     toString'd for the hover-source tooltips
// so the Node bench, the in-browser bench, and the tooltips can never drift.
//
// Wrapped in an IIFE so that, when loaded as a classic <script> alongside
// probes.js on the same page, its internals don't leak into (or collide in)
// the shared global lexical scope — only the explicit window export escapes.
(function () {
function awaitLoop(P, effectFn, N, N_RPC, work) {
    return effectFn('bench', async () => {
        let s = 0;
        for (let i = 0; i < N; i++) s += await P.resolve(1);
        if (s !== N) throw new Error('bad result');
    });
}
function thenChain(P, effectFn, N, N_RPC, work) {
    return effectFn('bench', () => {
        let p = P.resolve(0);
        for (let i = 0; i < N; i++) p = p.then((v) => v + 1);
        return p.then((v) => { if (v !== N) throw new Error('bad result'); });
    });
}
function fanout(P, effectFn, N, N_RPC, work) {
    return effectFn('bench', () => {
        const a = new Array(N);
        for (let i = 0; i < N; i++) a[i] = P.resolve(i).then((v) => v + 1);
        return P.all(a).then((r) => { if (r[N - 1] !== N) throw new Error('bad result'); });
    });
}
function awaitWork(P, effectFn, N, N_RPC, work) {
    return effectFn('bench', async () => {
        let s = 0;
        for (let i = 0; i < N_RPC; i++) { s += await P.resolve(1); s += work(2000) % 2; }
        if (s < N_RPC) throw new Error('bad result');
    });
}
function rpcTimer(P, effectFn, N, N_RPC, work) {
    return effectFn('bench', () => {
        const a = new Array(N_RPC);
        const one = async () => { await new P((r) => setTimeout(r, 0)); return 1; };
        for (let i = 0; i < N_RPC; i++) a[i] = one();
        return P.all(a).then((r) => { if (r.length !== N_RPC) throw new Error('bad result'); });
    });
}

const SCENARIOS = { awaitLoop, thenChain, fanout, awaitWork, rpcTimer };

// Build the { key: () => promise } table the timing loop iterates.
function mkScenarios(P, effectFn, N, N_RPC, work) {
    const out = {};
    for (const key of Object.keys(SCENARIOS)) {
        out[key] = () => SCENARIOS[key](P, effectFn, N, N_RPC, work);
    }
    return out;
}

// Dual-target export: Node via require, browser via a window global.
const api = { SCENARIOS, mkScenarios, SCEN: Object.keys(SCENARIOS) };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.Scenarios = api;
})();
