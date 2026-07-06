// Odoo boot benchmark — measures logged-in web client boot time with the
// promise patch off / proxy / v4, alternating arms run-by-run.
//
// Prerequisites:
//   1. Deploy instrumented-cancellablePromise.js over
//      <odoo>/addons/web/static/src/core/utils/cancellablePromise.js
//      (see header of that file; restore with git afterwards)
//   2. Odoo running (e.g. `goa odoo:start master-contextual-promise-nby`)
//   3. npm i playwright
//
// Usage: node bench/odoo-boot/run.js [baseUrl] [cycles]
//        node bench/odoo-boot/run.js http://localhost:8069 5
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:8069';
const CYCLES = Number(process.argv[3] || 5);
const MODES = ['off', 'proxy', 'v4'];
const SCENARIOS = [
  { name: 'homeApps', path: '/odoo', sel: '.o_app' },
  { name: 'appsKanban', path: '/odoo/apps', sel: '.o_kanban_record' },
  { name: 'settings', path: '/odoo/settings', sel: '.o_form_view' },
];

async function login(ctx) {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/web/login`, { waitUntil: 'domcontentloaded' });
  if (p.url().includes('/login')) {
    await p.fill('input[name="login"]', 'admin');
    await p.fill('input[name="password"]', 'admin');
    await Promise.all([
      p.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      p.click('button[type="submit"]'),
    ]);
  }
  await p.close();
}

async function bootOnce(ctx, mode, url, readySel) {
  const p = await ctx.newPage();
  try {
    await p.addInitScript((args) => {
      try { localStorage.setItem('cpImpl', args.m); } catch {}
      const attach = () => {
        if (!document.documentElement) { setTimeout(attach, 0); return; }
        const check = () => {
          if (document.querySelector(args.sel)) { window.__bootReady = performance.now(); return true; }
          return false;
        };
        if (check()) return;
        const obs = new MutationObserver(() => { if (check()) obs.disconnect(); });
        obs.observe(document.documentElement, { childList: true, subtree: true });
      };
      attach();
    }, { m: mode, sel: readySel });
    await p.goto(url, { waitUntil: 'commit', timeout: 60000 });
    await p.waitForSelector(readySel, { timeout: 60000 });
    const m = await p.evaluate(() => ({
      cpMode: window.__cpMode,
      bootMs: window.__bootReady,
      responseEnd: performance.timing.responseEnd - performance.timing.navigationStart,
      count: window.__cpCount ? window.__cpCount() : null,
    }));
    if (m.cpMode !== mode) {
      throw new Error(`mode mismatch (bundle stale? instrumented file deployed?): wanted ${mode} got ${m.cpMode}`);
    }
    return { total: Math.round(m.bootMs), client: Math.round(m.bootMs - m.responseEnd), count: m.count };
  } finally {
    await p.close();
  }
}

const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return { med: s[(s.length / 2) | 0], min: s[0], max: s[s.length - 1] };
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await login(ctx);

  for (const sc of SCENARIOS) {
    const url = BASE + sc.path;
    for (const m of MODES) await bootOnce(ctx, m, url, sc.sel); // warmup + bundle regen
    const res = { off: [], proxy: [], v4: [] };
    const counts = {};
    for (let c = 0; c < CYCLES; c++) {
      for (const m of MODES) {
        const r = await bootOnce(ctx, m, url, sc.sel);
        res[m].push(r);
        counts[m] = r.count;
      }
    }
    console.log(`\n${sc.name} (${sc.path}) — ${CYCLES} boots per mode, client-side ms (nav→${sc.sel}, minus server response)`);
    for (const m of MODES) {
      const cl = stats(res[m].map((r) => r.client));
      const to = stats(res[m].map((r) => r.total));
      const cnt = counts[m] === null ? '' : `  patched promise ops: ${counts[m]}`;
      console.log(`  ${m.padEnd(6)} client ${String(cl.med).padStart(4)}ms [${cl.min}-${cl.max}]   total ${String(to.med).padStart(4)}ms [${to.min}-${to.max}]${cnt}`);
    }
  }

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
