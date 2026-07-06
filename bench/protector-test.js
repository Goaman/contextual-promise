// Which mutations invalidate V8's global promise fast paths?
// Measures native awaitLoop+thenChain after each escalating mutation.
const { performance } = require('perf_hooks');
const N = 100_000, RUNS = 5;

async function awaitLoop() { let s = 0; for (let i = 0; i < N; i++) s += await Promise.resolve(1); return s; }
function thenChain() { let p = Promise.resolve(0); for (let i = 0; i < N; i++) p = p.then((v) => v + 1); return p; }

async function measure(fn) {
  await fn();
  const t = [];
  for (let i = 0; i < RUNS; i++) { global.gc?.(); const t0 = performance.now(); await fn(); t.push(performance.now() - t0); }
  t.sort((a, b) => a - b);
  return t[(RUNS / 2) | 0];
}

(async () => {
  const report = async (label) =>
    console.log(label.padEnd(38), 'awaitLoop', (await measure(awaitLoop)).toFixed(1) + 'ms', ' thenChain', (await measure(thenChain)).toFixed(1) + 'ms');

  await report('pristine');

  { const p = Promise.resolve(); p.constructor = { x: 1 }; }
  await report('after own `constructor` on 1 instance');

  { const p = Promise.resolve(); p.then = function (a, b) { return Promise.prototype.then.call(this, a, b); }; }
  await report('after own `then` on 1 instance');

  const nat = Promise.prototype.then;
  Promise.prototype.then = function (a, b) { return nat.call(this, a, b); };
  await report('after Promise.prototype.then patch');

  Promise.prototype.then = nat;
  await report('after restoring prototype.then');
})();
