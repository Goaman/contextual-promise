// Drives every implementation in implementations/ through the same two probes
// and renders a verdict panel for each. Each implementation is loaded in its
// own iframe so the files' top-level `const`s and window-global installs stay
// isolated from one another (and it works straight off file://).

const IMPLS = [
    { name: 'naive rpc() (colleague strategy)', path: 'implementations/00-naive.js' },
    { name: '00-original.js  (v4)', path: 'implementations/00-original.js' },
    { name: '01-proxy.js  (v1)', path: 'implementations/01-proxy.js' },
    { name: '02-subclass.js  (v2)', path: 'implementations/02-subclass.js' },
    { name: '03-single-stamp.js  (v3)', path: 'implementations/03-single-stamp.js' },
    { name: '04-v4-sandwich-always.js', path: 'implementations/04-v4-sandwich-always.js' },
    { name: '05-constructor-trap.js  (v5, awaiter-side)', path: 'implementations/05-constructor-trap.js' },
];

// ---------------------------------------------------------------------------
// Hover-for-source: the exact code behind each demo part / benchmark scenario,
// shown in a syntax-highlighted tooltip. Keys match the data-code attributes
// set on the part lines (renderPanel) and the scenario headers (renderBenchTable).
// ---------------------------------------------------------------------------
const CODE = {
    // demo parts
    A: `// PART A — each scope's .then() continuation must see its own scope
const a = effect('S1', () => rpc().then(() => seen.S1 = getCurrent()));
const b = effect('S2', () => rpc().then(() => seen.S2 = getCurrent()));
await Promise.all([a, b]);   // expect: S1 saw "S1", S2 saw "S2"`,
    B: `// PART B — each native async/await continuation must see its own scope
const a = effect('S1', () => (async () => {
  await rpc();
  seen.S1 = getCurrent();
})());
const b = effect('S2', () => (async () => {
  await rpc();
  seen.S2 = getCurrent();
})());
await Promise.all([a, b]);   // expect: S1 saw "S1", S2 saw "S2"`,
    Cbare: `// PART C (bare) — does context survive ONE layer of async composition?
// blip()'s promise is a native %Promise%, invisible to stamp-based impls.
async function blip()     { await rpc();  return getCurrent(); }
async function nestBare() { await blip(); return getCurrent(); }

out.Cbare = await effect('CTX', () => nestBare());   // expect: "CTX"`,
    Crestamp: `// PART C (re-stamp) — feed the intermediate through a tracked constructor
async function blip() { await rpc(); return getCurrent(); }
async function nestRestamp() {
  await Promise.resolve(blip());   // Promise.resolve() is patched -> stamped
  return getCurrent();
}
out.Crestamp = await effect('CTX', () => nestRestamp());   // expect: "CTX"`,
    D: `// PART D — await a SCOPED promise from OUTSIDE any scope; must stay clean
await effect('S1', () => rpc());
const leaked = getCurrent();   // expect: undefined (no leak)`,

    // benchmark scenarios (bodies as measured in bench/bench-one.js)
    awaitLoop: `effect('bench', async () => {
  let s = 0;
  for (let i = 0; i < N; i++)
    s += await P.resolve(1);       // N bare awaits in one scope
});`,
    thenChain: `effect('bench', () => {
  let p = P.resolve(0);
  for (let i = 0; i < N; i++)
    p = p.then((v) => v + 1);      // N-deep .then() chain
  return p;
});`,
    fanout: `effect('bench', () => {
  const a = new Array(N);
  for (let i = 0; i < N; i++)
    a[i] = P.resolve(i).then((v) => v + 1);   // N independent promises
  return P.all(a);
});`,
    awaitWork: `effect('bench', async () => {
  let s = 0;
  for (let i = 0; i < N_RPC; i++) {
    s += await P.resolve(1);
    s += work(2000) % 2;           // ~1-2us of real CPU per hop
  }
});`,
    rpcTimer: `effect('bench', () => {
  const one = async () => {
    await new P((r) => setTimeout(r, 0));   // real macrotask boundary
    return 1;
  };
  const a = new Array(N_RPC);
  for (let i = 0; i < N_RPC; i++) a[i] = one();
  return P.all(a);
});`,
};

// Tiny dependency-free JS highlighter (CSP / file:// friendly): escape, then
// tag comments, strings, keywords, numbers, and call-position identifiers.
function highlight(code) {
    const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.replace(
        /(\/\/[^\n]*)|(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|\b(const|let|var|function|return|async|await|for|if|else|new|throw|of|in|typeof|instanceof|class|extends|void)\b|\b(\d+)\b|\b([A-Za-z_$][\w$]*)(?=\s*\()/g,
        (m, com, str, kw, num, fn) => {
            if (com) return `<span class="tok-com">${com}</span>`;
            if (str) return `<span class="tok-str">${str}</span>`;
            if (kw) return `<span class="tok-kw">${kw}</span>`;
            if (num) return `<span class="tok-num">${num}</span>`;
            if (fn) return `<span class="tok-fn">${fn}</span>`;
            return m;
        }
    );
}

// One shared tooltip, driven by event delegation so it also covers the benchmark
// tables that are built on demand.
const codeTip = document.getElementById('code-tip');
function positionTip(el) {
    const r = el.getBoundingClientRect();
    codeTip.style.left = '0px';
    codeTip.style.top = '0px';
    const tw = codeTip.offsetWidth, th = codeTip.offsetHeight;
    let left = r.left;
    if (left + tw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - tw - 8);
    let top = r.bottom + 6;
    if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 6); // flip above
    codeTip.style.left = left + 'px';
    codeTip.style.top = top + 'px';
}
document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.has-tip');
    if (!el) return;
    const code = CODE[el.dataset.code];
    if (!code) return;
    codeTip.innerHTML = highlight(code);
    codeTip.classList.add('show');
    positionTip(el);
});
document.addEventListener('mouseout', (e) => {
    const el = e.target.closest('.has-tip');
    if (el && !el.contains(e.relatedTarget)) codeTip.classList.remove('show');
});

const verdict = (s) =>
    s.S1 === 'S1' && s.S2 === 'S2'
        ? 'OK'
        : `WRONG  (S1 saw "${s.S1}", S2 saw "${s.S2}")`;

const cverdict = (v) => (v === 'CTX' ? 'OK  (saw CTX)' : `LOST  (saw ${JSON.stringify(v)})`);

const dverdict = (v) => (v == null ? 'OK  (stayed clean)' : `LEAK  (awaiter saw ${JSON.stringify(v)})`);

// The probe runs *inside* each impl's iframe. It uses the uniform interface
// every implementation exposes on window: install / uninstall / effect /
// getCurrent, plus an optional rpc() (the naive strategy needs its bespoke
// thenable; the patched-Promise impls just use Promise.resolve()).
function runnerSource() {
    return `
    (async () => {
      try {
        const rpc = window.rpc || (() => Promise.resolve());
        install();
        const out = {};
        {
          const seen = {};
          const a = effect('S1', () => rpc().then(() => (seen.S1 = getCurrent())));
          const b = effect('S2', () => rpc().then(() => (seen.S2 = getCurrent())));
          await Promise.all([a, b]);
          out.A = seen;
        }
        {
          const seen = {};
          const a = effect('S1', () => (async () => { await rpc(); seen.S1 = getCurrent(); })());
          const b = effect('S2', () => (async () => { await rpc(); seen.S2 = getCurrent(); })());
          await Promise.all([a, b]);
          out.B = seen;
        }
        // PART C: does context survive ONE layer of async composition? blip() is
        // an async fn; something() awaits its result. blip()'s promise is a
        // NATIVE %Promise% (async fns always use the intrinsic), so its stamp-
        // based interception never triggers... but the await's Get(value,
        // "constructor") IS observable, and 05-constructor-trap intercepts it
        // with a prototype accessor that captures the awaiter's context at the
        // suspension point — bare composition works there. For the stamp-only
        // impls, re-stamping the intermediate through a tracked constructor
        // (\`Promise.resolve(blip())\`) hands them a promise they own, so they
        // restore context around the resume; naive can't (it only tracks its
        // bespoke thenable).
        {
          async function blip() { await rpc(); return getCurrent(); }
          async function nestBare() { await blip(); return getCurrent(); }
          async function nestRestamp() { await Promise.resolve(blip()); return getCurrent(); }
          out.Cbare = await effect('CTX', () => nestBare());
          out.Crestamp = await effect('CTX', () => nestRestamp());
        }
        // PART D: the flip side of C — awaiting a SCOPED promise from OUTSIDE
        // any scope. Resolver-side designs (the naive thenable and the stamp
        // impls v1-v4) restore the promise's CREATION scope around whoever
        // awaits it, so the scope leaks into an awaiter that never entered it
        // (transiently: the next bare native await cuts the chain — which is
        // the only reason v4's leak-check test ever passed). Awaiter-side
        // capture (v5) resumes out-of-scope awaiters natively: clean.
        {
          await effect('S1', () => rpc());
          const leaked = getCurrent();
          out.D = leaked === undefined ? null : leaked;
        }
        uninstall();
        parent.postMessage({ __probe: RUN_ID, out }, '*');
      } catch (err) {
        parent.postMessage({ __probe: RUN_ID, error: String(err && err.stack || err) }, '*');
      }
    })();
  `;
}

function runImpl(impl, runId) {
    return new Promise((resolve) => {
        const onMessage = (e) => {
            if (!e.data || e.data.__probe !== runId) return;
            window.removeEventListener('message', onMessage);
            iframe.remove();
            resolve(e.data);
        };
        window.addEventListener('message', onMessage);

        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        // Relative script src in srcdoc resolves against this document's base
        // URL (the repo root), so `implementations/…` finds the sibling files.
        iframe.srcdoc = `<!DOCTYPE html><html><head>
      <script>window.RUN_ID = ${JSON.stringify(runId)};<\/script>
      <script src="${impl.path}"><\/script>
      <script>${runnerSource()}<\/script>
    </head><body></body></html>`;
        document.body.appendChild(iframe);

        setTimeout(() => {
            window.removeEventListener('message', onMessage);
            iframe.remove();
            resolve({ error: 'timeout' });
        }, 5000);
    });
}

function renderPanel(impl, data) {
    const panel = document.createElement('div');
    panel.className = 'panel';

    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = impl.name;
    panel.appendChild(title);

    const body = document.createElement('div');
    body.className = 'panel-body';
    panel.appendChild(body);

    const line = (msg, codeKey) => {
        const div = document.createElement('div');
        div.className = 'log ' + (msg.includes('OK') ? 'ok' : /WRONG|ERROR|LOST|LEAK/.test(msg) ? 'wrong' : 'muted');
        if (codeKey) { div.classList.add('has-tip'); div.dataset.code = codeKey; }
        div.textContent = msg;
        body.appendChild(div);
        console.log(`[${impl.path}]`, msg);
    };

    if (data.error) {
        line('ERROR  ' + data.error.split('\n')[0]);
    } else {
        line('PART A  .then(callback):          ' + verdict(data.out.A), 'A');
        line('PART B  async/await:              ' + verdict(data.out.B), 'B');
        line('PART C  await blip() (bare):      ' + cverdict(data.out.Cbare), 'Cbare');
        line('PART C  await Promise.resolve(…): ' + cverdict(data.out.Crestamp), 'Crestamp');
        line('PART D  await scoped from outside ' + dverdict(data.out.D), 'D');
    }
    document.getElementById('panels').appendChild(panel);
}

(async () => {
    for (let i = 0; i < IMPLS.length; i++) {
        const impl = IMPLS[i];
        const data = await runImpl(impl, `run-${i}`);
        renderPanel(impl, data);
    }
})();

// ---------------------------------------------------------------------------
// Benchmarks — an in-browser port of bench/bench-one.js. Each implementation
// runs its scenarios in its own iframe; a pristine native baseline (protectors
// intact, no lib ever loaded) is measured in a separate lib-free iframe. The
// naive impl is skipped: its rpc() thenable is not a drop-in Promise.
// ---------------------------------------------------------------------------

const SCEN = ['awaitLoop', 'thenChain', 'fanout', 'awaitWork', 'rpcTimer'];

// Browser-scaled work sizes (bench-one uses 100k / 5k; that would freeze a tab
// for far too long). Everything else mirrors bench-one.js exactly.
const BENCH_CFG = { N: 20000, N_RPC: 800, RUNS: 5 };

// Shared prelude injected into every bench iframe: the scenario table and the
// median-of-RUNS measurement loop, parameterised by (P, effectFn) just like
// bench-one's mkScenarios / measureAll.
function benchPrelude() {
    return `
    const { N, N_RPC, RUNS } = ${JSON.stringify(BENCH_CFG)};
    const work = (iters) => { let x = 0; for (let j = 0; j < iters; j++) x += j * j; return x; };
    const mkScenarios = (P, effectFn) => ({
      awaitLoop: () => effectFn('bench', async () => {
        let s = 0; for (let i = 0; i < N; i++) s += await P.resolve(1);
        if (s !== N) throw new Error('bad result');
      }),
      thenChain: () => effectFn('bench', () => {
        let p = P.resolve(0); for (let i = 0; i < N; i++) p = p.then((v) => v + 1);
        return p.then((v) => { if (v !== N) throw new Error('bad result'); });
      }),
      fanout: () => effectFn('bench', () => {
        const a = new Array(N);
        for (let i = 0; i < N; i++) a[i] = P.resolve(i).then((v) => v + 1);
        return P.all(a).then((r) => { if (r[N - 1] !== N) throw new Error('bad result'); });
      }),
      awaitWork: () => effectFn('bench', async () => {
        let s = 0;
        for (let i = 0; i < N_RPC; i++) { s += await P.resolve(1); s += work(2000) % 2; }
        if (s < N_RPC) throw new Error('bad result');
      }),
      rpcTimer: () => effectFn('bench', () => {
        const a = new Array(N_RPC);
        const one = async () => { await new P((r) => setTimeout(r, 0)); return 1; };
        for (let i = 0; i < N_RPC; i++) a[i] = one();
        return P.all(a).then((r) => { if (r.length !== N_RPC) throw new Error('bad result'); });
      }),
    });
    async function measureAll(P, effectFn) {
      const out = {};
      const scenarios = mkScenarios(P, effectFn);
      for (const [key, fn] of Object.entries(scenarios)) {
        await fn(); // warmup
        const times = [];
        for (let i = 0; i < RUNS; i++) {
          const t0 = performance.now();
          await fn();
          times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        out[key] = times[Math.floor(RUNS / 2)];
      }
      return out;
    }`;
}

// The baseline iframe loads no library, so window.Promise is pristine native
// with V8's promise protectors still intact — the honest denominator.
function baselineRunnerSource() {
    return `
    (async () => {
      try {
        ${benchPrelude()}
        const passthrough = (n, f) => f();
        const native = await measureAll(Promise, passthrough);
        class FloorPromise extends Promise {}
        const floor = await measureAll(FloorPromise, passthrough);
        parent.postMessage({ __bench: RUN_ID, out: { native, floor } }, '*');
      } catch (err) {
        parent.postMessage({ __bench: RUN_ID, error: String(err && err.stack || err) }, '*');
      }
    })();`;
}

// An impl iframe: the lib is loaded (and auto-installed) before this runs. We
// measure it twice — inside an effect scope (tracked) and outside any scope
// (untracked, lib still installed) — mirroring bench-all's two tables.
function implRunnerSource() {
    return `
    (async () => {
      try {
        ${benchPrelude()}
        const passthrough = (n, f) => f();
        install();
        const impl = await measureAll(window.Promise, window.effect);
        const untracked = await measureAll(window.Promise, passthrough);
        uninstall();
        parent.postMessage({ __bench: RUN_ID, out: { impl, untracked } }, '*');
      } catch (err) {
        parent.postMessage({ __bench: RUN_ID, error: String(err && err.stack || err) }, '*');
      }
    })();`;
}

// Spawn an iframe, optionally loading an impl script, run the given inner
// source, and resolve with whatever it postMessages back (tagged __bench).
function runBench(implPath, innerSrc, runId) {
    return new Promise((resolve) => {
        const onMessage = (e) => {
            if (!e.data || e.data.__bench !== runId) return;
            window.removeEventListener('message', onMessage);
            clearTimeout(timer);
            iframe.remove();
            resolve(e.data);
        };
        window.addEventListener('message', onMessage);

        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        const implScript = implPath ? `<script src="${implPath}"><\/script>` : '';
        iframe.srcdoc = `<!DOCTYPE html><html><head>
      <script>window.RUN_ID = ${JSON.stringify(runId)};<\/script>
      ${implScript}
      <script>${innerSrc}<\/script>
    </head><body></body></html>`;
        document.body.appendChild(iframe);

        // Longer than the demo probe: 100k-hop scenarios + a timer fanout are slow.
        const timer = setTimeout(() => {
            window.removeEventListener('message', onMessage);
            iframe.remove();
            resolve({ error: 'timeout' });
        }, 60000);
    });
}

const ratioClass = (r) => (r < 1.5 ? 'ratio-good' : r < 3 ? 'ratio-mid' : 'ratio-bad');

function renderBenchTable(caption, baseline, rows) {
    const table = document.createElement('table');
    table.className = 'bench';
    table.innerHTML =
        `<caption>${caption}</caption>` +
        '<tr><th class="mode">mode</th>' +
        SCEN.map((s) => `<th class="has-tip" data-code="${s}">${s}</th>`).join('') + '</tr>';

    for (const row of rows) {
        const tr = document.createElement('tr');
        let cells = `<td class="mode">${row.label}</td>`;
        if (row.error) {
            cells += `<td colspan="${SCEN.length}" style="text-align:left" class="ratio-bad">${row.error}</td>`;
        } else if (!row.times) {
            cells += `<td colspan="${SCEN.length}" style="text-align:left" class="muted">${row.note || 'n/a'}</td>`;
        } else {
            cells += SCEN.map((s) => {
                const ms = row.times[s];
                const base = baseline && baseline[s];
                const ratio = base ? ms / base : null;
                const rtxt = ratio == null
                    ? ''
                    : ` <span class="${ratioClass(ratio)}">${ratio.toFixed(2)}x</span>`;
                return `<td>${ms.toFixed(1)}ms${rtxt}</td>`;
            }).join('');
        }
        tr.innerHTML = cells;
        table.appendChild(tr);
    }
    document.getElementById('bench-results').appendChild(table);
}

async function runBenchmarks() {
    const btn = document.getElementById('run-bench');
    const status = document.getElementById('bench-status');
    const results = document.getElementById('bench-results');
    btn.disabled = true;
    results.innerHTML = '';

    // 1. Pristine native + floor baseline (no lib loaded).
    status.textContent = 'measuring native baseline…';
    const baseData = await runBench(null, baselineRunnerSource(), 'bench-baseline');
    if (baseData.error) {
        status.textContent = 'baseline failed: ' + baseData.error.split('\n')[0];
        btn.disabled = false;
        return;
    }
    const native = baseData.out.native;
    const floor = baseData.out.floor;

    // 2. Each impl (naive skipped — no Promise drop-in).
    const tracked = [];
    const untracked = [];
    for (let i = 0; i < IMPLS.length; i++) {
        const impl = IMPLS[i];
        if (/00-naive/.test(impl.path)) {
            tracked.push({ label: impl.name, note: 'n/a — no Promise drop-in' });
            untracked.push({ label: impl.name, note: 'n/a — no Promise drop-in' });
            continue;
        }
        status.textContent = `benchmarking ${impl.name} (${i + 1}/${IMPLS.length})…`;
        const data = await runBench(impl.path, implRunnerSource(), `bench-${i}`);
        if (data.error) {
            tracked.push({ label: impl.name, error: data.error.split('\n')[0] });
            untracked.push({ label: impl.name, error: data.error.split('\n')[0] });
        } else {
            tracked.push({ label: impl.name, times: data.out.impl });
            untracked.push({ label: impl.name, times: data.out.untracked });
        }
    }

    const cfg = `${BENCH_CFG.N.toLocaleString()} hops (${BENCH_CFG.N_RPC.toLocaleString()} for await-work / rpc-timer), median of ${BENCH_CFG.RUNS}`;
    renderBenchTable(
        `tracked — inside an effect scope · ${cfg} · ratio vs pristine native`,
        native,
        [
            { label: 'native (pristine)', times: native },
            { label: 'floor (class extends Promise)', times: floor },
            ...tracked,
        ]
    );
    renderBenchTable(
        'untracked — lib installed, promises created outside any effect scope · ratio vs pristine native',
        native,
        untracked
    );

    status.textContent = 'done.';
    btn.disabled = false;
}

document.getElementById('run-bench').addEventListener('click', runBenchmarks);
