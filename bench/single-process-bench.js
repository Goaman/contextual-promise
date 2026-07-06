// Benchmark: native vs patched (cancellablePromise) promise machinery.
// Phases matter: V8's promise fast paths rely on "protector" cells that are
// invalidated the moment Promise.prototype.then is patched, and never
// revalidated. So we measure pristine native BEFORE loading the lib,
// then patched, then native-after-uninstall to expose the residual cost.

const { performance } = require('perf_hooks');

const N = 100_000;
const RUNS = 7;

async function awaitLoop() {
  let s = 0;
  for (let i = 0; i < N; i++) s += await Promise.resolve(1);
  if (s !== N) throw new Error('bad result');
}

async function thenChain() {
  let p = Promise.resolve(0);
  for (let i = 0; i < N; i++) p = p.then((v) => v + 1);
  const v = await p;
  if (v !== N) throw new Error('bad result');
}

async function fanout() {
  const arr = new Array(N);
  for (let i = 0; i < N; i++) arr[i] = Promise.resolve(i).then((v) => v + 1);
  const r = await Promise.all(arr);
  if (r[N - 1] !== N) throw new Error('bad result');
}

const SCENARIOS = { awaitLoop, thenChain, fanout };

async function measure(fn, wrap) {
  await wrap(fn); // warmup
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    global.gc?.();
    const t0 = performance.now();
    await wrap(fn);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(RUNS / 2)]; // median
}

async function phase(name, wrap) {
  const out = {};
  for (const [key, fn] of Object.entries(SCENARIOS)) {
    out[key] = await measure(fn, wrap);
    process.stderr.write(`  ${name}/${key}: ${out[key].toFixed(1)} ms\n`);
  }
  return out;
}

const identity = (fn) => fn();

(async () => {
  const results = {};

  results.pristine = await phase('native-pristine', identity);

  globalThis.window = globalThis;
  require(require('path').resolve(process.argv[2])); // loads lib, install() patches window.Promise

  results.patched = await phase('patched', (fn) => effect('bench', fn));

  uninstall();
  results.after = await phase('native-after-uninstall', identity);

  // report
  const fmt = (ms) => ms.toFixed(1).padStart(9);
  const mops = (ms) => ((N / ms) / 1000).toFixed(0).padStart(5); // k promises/sec... per ms => k/ms = M/s
  console.log(`\n${N.toLocaleString()} promises per run, median of ${RUNS} runs (ms)\n`);
  console.log('scenario   | native pristine | patched (in effect) | native after uninstall | slowdown');
  console.log('-----------|-----------------|---------------------|------------------------|---------');
  for (const key of Object.keys(SCENARIOS)) {
    const p = results.pristine[key], m = results.patched[key], a = results.after[key];
    console.log(
      `${key.padEnd(10)} | ${fmt(p)} ms      | ${fmt(m)} ms          | ${fmt(a)} ms            | ${(m / p).toFixed(1)}x`
    );
  }
  console.log('\nthroughput (million promise-hops / sec)');
  for (const key of Object.keys(SCENARIOS)) {
    const p = results.pristine[key], m = results.patched[key], a = results.after[key];
    console.log(
      `${key.padEnd(10)} | pristine ${mops(p)} M/s | patched ${mops(m)} M/s | after-uninstall ${mops(a)} M/s`
    );
  }
})().catch((e) => { console.error(e); process.exit(1); });
