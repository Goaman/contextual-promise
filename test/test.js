// Correctness suite for the cancellable/contextual promise implementations.
// Usage: node test/test.js [path-to-implementation]   (default: ../implementations/00-original.js)
const path = require('path');
globalThis.window = globalThis;
require(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'implementations', '00-original.js'));

const assert = require('assert');
const rpc = () => Promise.resolve();

(async () => {
  // Part A: .then(callback)
  {
    const seen = {};
    const a = effect('S1', () => rpc().then(() => (seen.S1 = getCurrent())));
    const b = effect('S2', () => rpc().then(() => (seen.S2 = getCurrent())));
    await Promise.all([a, b]);
    console.log('PART A .then       ', JSON.stringify(seen));
    assert.deepStrictEqual(seen, { S1: 'S1', S2: 'S2' }, 'Part A');
  }
  // Part B: async/await (the case the original implementation failed)
  {
    const seen = {};
    const a = effect('S1', () => (async () => { await rpc(); seen.S1 = getCurrent(); })());
    const b = effect('S2', () => (async () => { await rpc(); seen.S2 = getCurrent(); })());
    await Promise.all([a, b]);
    console.log('PART B async/await ', JSON.stringify(seen));
    assert.deepStrictEqual(seen, { S1: 'S1', S2: 'S2' }, 'Part B');
  }
  // C: multiple sequential awaits, interleaved scopes, incl. `new Promise`
  {
    const seen = { S1: [], S2: [] };
    const mk = (name) => effect(name, () => (async () => {
      await rpc(); seen[name].push(getCurrent());
      await rpc(); seen[name].push(getCurrent());
      await new Promise((r) => r(1)); seen[name].push(getCurrent());
    })());
    await Promise.all([mk('S1'), mk('S2')]);
    console.log('C multi-await      ', JSON.stringify(seen));
    assert.deepStrictEqual(seen, { S1: ['S1', 'S1', 'S1'], S2: ['S2', 'S2', 'S2'] }, 'C');
  }
  // D: chained .then().then()
  {
    const seen = [];
    await effect('S1', () => rpc().then(() => 1).then(() => seen.push(getCurrent())));
    console.log('D chained then     ', JSON.stringify(seen));
    assert.deepStrictEqual(seen, ['S1'], 'D');
  }
  // E: rejection through await keeps context in catch
  {
    let caught;
    await effect('S1', () => (async () => {
      try { await Promise.reject(new Error('x')); } catch { caught = getCurrent(); }
    })());
    console.log('E await rejection  ', JSON.stringify(caught));
    assert.strictEqual(caught, 'S1', 'E');
  }
  // F: no context leaks once everything settled
  await new Promise((r) => setTimeout(r, 20));
  console.log('F leak check       ', JSON.stringify(getCurrent()));
  assert.strictEqual(getCurrent(), undefined, 'F: context stack not balanced');

  // G: bare async composition — `await blip()` awaits the async fn's implicit
  // NATIVE promise. Only impls that trap the awaiter's constructor lookup
  // (05-constructor-trap) support this; others declare the limitation.
  if (window.SUPPORTS_BARE_AWAIT_COMPOSITION) {
    const seen = {};
    const blip = async () => { await rpc(); };
    const mk = (name) => effect(name, () => (async () => {
      await blip(); seen[name] = getCurrent();
    })());
    await Promise.all([mk('S1'), mk('S2')]);
    console.log('G bare composition ', JSON.stringify(seen));
    assert.deepStrictEqual(seen, { S1: 'S1', S2: 'S2' }, 'G');
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(getCurrent(), undefined, 'G: context stack not balanced');
  } else {
    console.log('G bare composition  skipped (impl declares the limitation)');
  }

  console.log('ALL PASS');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
