// Correctness suite for the cancellable/contextual promise implementations.
// Runs the SAME probe set the demo page renders (../probes.js) and asserts the
// expected verdict for each part — so the demo and the test can never diverge.
// Usage: node test/test.js [path-to-implementation]   (default: ../implementations/00-original.js)
const path = require('path');
globalThis.window = globalThis;
require(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'implementations', '00-original.js'));

const assert = require('assert');
const { runProbes } = require(path.join(__dirname, '..', 'probes.js'));

(async () => {
  install();
  const out = await runProbes({
    effect: window.effect,
    getCurrent: window.getCurrent,
    rpc: window.rpc,
    effectCancellable: window.effectCancellable,
  });

  // A / B / C-restamp hold for every context-propagating impl.
  console.log('PART A .then                  ', JSON.stringify(out.A));
  assert.deepStrictEqual(out.A, { S1: 'S1', S2: 'S2' }, 'Part A: .then continuation');

  console.log('PART B async/await            ', JSON.stringify(out.B));
  assert.deepStrictEqual(out.B, { S1: 'S1', S2: 'S2' }, 'Part B: async/await continuation');

  console.log('PART C await Promise.resolve  ', JSON.stringify(out.Crestamp));
  assert.strictEqual(out.Crestamp, 'CTX', 'Part C: re-stamped composition');

  // Bare composition (C-bare) and clean out-of-scope await (D) only hold for
  // awaiter-side impls; the others declare the limitation (see demo Parts C/D).
  if (window.SUPPORTS_BARE_AWAIT_COMPOSITION) {
    console.log('PART C await blip() (bare)    ', JSON.stringify(out.Cbare));
    assert.strictEqual(out.Cbare, 'CTX', 'Part C: bare composition');

    console.log('PART D await scoped outside   ', JSON.stringify(out.D));
    assert.strictEqual(out.D, null, 'Part D: scope leaked into outside awaiter');
  } else {
    console.log('PART C await blip() (bare)     skipped (impl declares the limitation)');
    console.log('PART D await scoped outside    skipped (impl declares the limitation)');
  }

  // PART E: one shared promise awaited by two scopes at once. Ideal is
  // { A: 'A', B: 'B' } — per-awaiter impls (v6's one-shot then) assert it;
  // for the rest a shared promise has a single identity (v5's single pending
  // slot documents the limitation), so it's reported for diagnosis only.
  if (window.SUPPORTS_PER_AWAITER_CONTEXT) {
    console.log('PART E shared promise         ', JSON.stringify(out.E));
    assert.deepStrictEqual(out.E, { A: 'A', B: 'B' }, 'Part E: per-awaiter context on a shared promise');
  } else {
    console.log('PART E shared promise         ', `{ A: ${out.E.A}, B: ${out.E.B} }`,
      (out.E.A === 'A' && out.E.B === 'B') ? '(OK)' : '(known limitation — no per-awaiter context on a shared promise)');
  }

  // PART F: cancellation × the shared await of Part E — cancel S1 while S1 and
  // S2 both await one in-flight gate created inside S1. Ideal: S1's
  // continuation skipped, S2 resumes in its own scope. Per-awaiter impls (v6)
  // assert it; the rest report their failure mode (S2 hung, or the cancelled
  // scope running) for diagnosis. Every impl with a handle must at least NEVER
  // resume the cancelled scope in its own name.
  if (out.F === null) {
    console.log('PART F cancel × shared await   n/a (no cancellation handle)');
  } else if (window.SUPPORTS_PER_AWAITER_CONTEXT) {
    console.log('PART F cancel × shared await  ', JSON.stringify(out.F));
    assert.deepStrictEqual(out.F, { S1: 'skipped', S2: 'S2' }, 'Part F: cancellation must skip exactly the cancelled scope');
  } else {
    console.log('PART F cancel × shared await  ', JSON.stringify(out.F),
      (out.F.S1 === 'skipped' && out.F.S2 === 'S2') ? '(OK)' : '(known limitation — see probes.js Part F)');
    assert.notStrictEqual(out.F.S1, 'S1', 'Part F: a cancelled scope must never resume as itself');
  }

  // Invariant: once everything has settled, no scope is left on the stack.
  await new Promise((r) => setTimeout(r, 20));
  console.log('leak check                    ', JSON.stringify(getCurrent()));
  assert.strictEqual(getCurrent(), undefined, 'context stack not balanced');

  console.log('ALL PASS');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
