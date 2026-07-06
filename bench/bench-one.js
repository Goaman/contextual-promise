// bench-one.js <mode> <libPath>
// Measures pristine native FIRST (before loading anything), then the mode's
// implementation, in the same process. One process per mode so protector
// invalidation / global patches can't leak between modes.
const { performance } = require('perf_hooks');
const path = require('path');
const { mkScenarios } = require(path.join(__dirname, '..', 'scenarios.js'));

const MODE = process.argv[2];
const LIB = process.argv[3];
const N = 100_000;
const N_RPC = 5_000;
const RUNS = 7;

// ~1-2us of real CPU work per hop, identical code in every mode
const work = (iters) => { let x = 0; for (let j = 0; j < iters; j++) x += j * j; return x; };

async function measureAll(P, effectFn) {
  const out = {};
  const scenarios = mkScenarios(P, effectFn, N, N_RPC, work);
  for (const [key, fn] of Object.entries(scenarios)) {
    await fn(); // warmup
    const times = [];
    for (let i = 0; i < RUNS; i++) {
      global.gc?.();
      const t0 = performance.now();
      await fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    out[key] = times[Math.floor(RUNS / 2)];
  }
  return out;
}

async function verifyContext(P, effectFn, getCurrent) {
  const rpc = () => P.resolve();
  const seenA = {};
  await P.all([
    effectFn('S1', () => rpc().then(() => (seenA.S1 = getCurrent()))),
    effectFn('S2', () => rpc().then(() => (seenA.S2 = getCurrent()))),
  ]);
  const seenB = {};
  await P.all([
    effectFn('S1', () => (async () => { await rpc(); seenB.S1 = getCurrent(); })()),
    effectFn('S2', () => (async () => { await rpc(); seenB.S2 = getCurrent(); })()),
  ]);
  const ok = seenA.S1 === 'S1' && seenA.S2 === 'S2' && seenB.S1 === 'S1' && seenB.S2 === 'S2';
  return { ok, seenA, seenB };
}

function setup() {
  const passthrough = (name, fn) => fn();
  if (MODE === 'native') return { P: Promise, effectFn: passthrough };
  if (MODE === 'floor') {
    class FloorPromise extends Promise {}
    return { P: FloorPromise, effectFn: passthrough };
  }
  if (LIB) {
    globalThis.window = globalThis;
    require(require('path').resolve(LIB));
    return { P: globalThis.Promise, effectFn: globalThis.effect, getCurrent: globalThis.getCurrent };
  }
  throw new Error('unknown mode: ' + MODE);
}

(async () => {
  const native = await measureAll(Promise, (n, f) => f());
  const { P, effectFn, getCurrent } = setup();
  const verified = getCurrent ? await verifyContext(P, effectFn, getCurrent) : null;
  const impl = await measureAll(P, effectFn);
  // lib installed, but promises created OUTSIDE any effect scope
  const untracked = LIB ? await measureAll(P, (n, f) => f()) : null;
  console.log(JSON.stringify({ mode: MODE, node: process.version, native, impl, untracked, verified }));
})().catch((e) => { console.error(e); process.exit(1); });
