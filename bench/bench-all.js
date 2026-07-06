// Runs each mode in its own node process and prints a comparison table.
// Usage: node bench/bench-all.js
// One process per mode so protector invalidation / global patches can't leak
// between modes; each mode is self-baselined against pristine native measured
// in-process BEFORE its library loads.
const { spawnSync } = require('child_process');
const path = require('path');

const HERE = __dirname;
const IMPL = (f) => path.join(HERE, '..', 'implementations', f);

const MODES = [
  { mode: 'native', lib: null },                                    // control: native measured twice
  { mode: 'floor', lib: null },                                     // empty `class extends Promise` — cost of interceptability alone
  { mode: 'proxy', lib: IMPL('01-proxy.js') },
  { mode: 'subclass', lib: IMPL('02-subclass.js') },
  { mode: 'v3', lib: IMPL('03-single-stamp.js') },
  { mode: 'v4', lib: IMPL('00-original.js') },
  { mode: 'v4-sand', lib: IMPL('04-v4-sandwich-always.js') }, // sandwich on every wrapped hop
  { mode: 'v5-trap', lib: IMPL('05-constructor-trap.js') },   // constructor trap: awaiter-side bare-await capture
];

const results = [];
for (const { mode, lib } of MODES) {
  const args = ['--expose-gc', path.join(HERE, 'bench-one.js'), mode];
  if (lib) args.push(lib);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`mode ${mode} FAILED:\n${r.stderr}`);
    continue;
  }
  const lines = r.stdout.trim().split('\n');
  results.push(JSON.parse(lines[lines.length - 1]));
  process.stderr.write(`done: ${mode}\n`);
}

const SCEN = ['awaitLoop', 'thenChain', 'fanout', 'awaitWork', 'rpcTimer'];
console.log(`\nnode ${results[0].node} — median ms (ratio vs same-process pristine native)\n`);
const header = ['mode'.padEnd(9), ...SCEN.map((s) => s.padStart(18))].join(' | ');
console.log(header);
console.log('-'.repeat(header.length));
for (const r of results) {
  const cells = SCEN.map((s) => {
    const ratio = r.impl[s] / r.native[s];
    return `${r.impl[s].toFixed(1)}ms ${ratio.toFixed(2)}x`.padStart(18);
  });
  const v = r.verified ? (r.verified.ok ? ' ctx:OK' : ' ctx:BROKEN!') : '';
  console.log([r.mode.padEnd(9), ...cells].join(' | ') + v);
}
console.log('\nuntracked (lib installed, promises outside any effect scope):');
for (const r of results) {
  if (!r.untracked) continue;
  const cells = SCEN.map((s) => {
    const ratio = r.untracked[s] / r.native[s];
    return `${r.untracked[s].toFixed(1)}ms ${ratio.toFixed(2)}x`.padStart(18);
  });
  console.log([r.mode.padEnd(9), ...cells].join(' | '));
}
