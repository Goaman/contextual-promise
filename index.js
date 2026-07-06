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
    { name: '06-one-shot-then.js  (v6, per-awaiter)', path: 'implementations/06-one-shot-then.js' },
];

// ---------------------------------------------------------------------------
// Hover-for-source: the exact code behind each demo part / benchmark scenario,
// shown in a syntax-highlighted tooltip. There is NO copy of the code here — we
// pull the *body* straight out of the single-source functions (probes.js's
// PARTS and scenarios.js's SCENARIOS, both loaded before this script) with
// Function.prototype.toString, so a tooltip can never show something different
// from what actually runs. The two demo C-lines both point at PARTS.C.
// ---------------------------------------------------------------------------
const CODE = {
    A: Probes.PARTS.A, B: Probes.PARTS.B,
    Cbare: Probes.PARTS.C, Crestamp: Probes.PARTS.C, D: Probes.PARTS.D, E: Probes.PARTS.E,
    F: Probes.PARTS.F,
    awaitLoop: Scenarios.SCENARIOS.awaitLoop, thenChain: Scenarios.SCENARIOS.thenChain,
    fanout: Scenarios.SCENARIOS.fanout, awaitWork: Scenarios.SCENARIOS.awaitWork,
    rpcTimer: Scenarios.SCENARIOS.rpcTimer,
};

// The snippet is the function's body: everything between the `{` that opens the
// body (the first `{` after the parameter list) and the last `}`, with the
// common leading indentation stripped.
function snippetOf(fn) {
    const src = fn.toString();
    const open = src.indexOf('{', src.indexOf(')'));
    const inner = src.slice(open + 1, src.lastIndexOf('}'));
    const lines = inner.replace(/^\n+|\s+$/g, '').split('\n');
    const indent = Math.min(
        ...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length)
    );
    return lines.map((l) => l.slice(indent)).join('\n');
}

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
    const fn = CODE[el.dataset.code];
    if (!fn) return;
    codeTip.innerHTML = highlight(snippetOf(fn));
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

// PART E: one shared promise awaited by scopes A and B. Ideal is A→A, B→B —
// reached by v6's one-shot then; every other impl shows what it returns instead.
const everdict = (s) =>
    s.A === 'A' && s.B === 'B'
        ? 'OK  (A→A, B→B)'
        : `SHARED  (A saw ${JSON.stringify(s.A)}, B saw ${JSON.stringify(s.B)})`;

// PART F: cancel S1 while S1 and S2 both await one in-flight gate created in
// S1. Ideal: S1 skipped, S2 resumes in S2 (v6). Failure modes: S2 hung
// (resolver-side skips both) or the cancelled S1 running anyway (v5's slot).
const fverdict = (s) => {
    if (s == null) return 'n/a  (no cancellation handle)';
    if (s.S1 === 'skipped' && s.S2 === 'S2') return 'OK  (S1 skipped, S2→S2)';
    const s1 = s.S1 === 'skipped' ? 'S1 skipped' : `cancelled S1 RAN (saw ${JSON.stringify(s.S1)})`;
    const s2 = s.S2 === 'hung' ? 'S2 HUNG' : `S2 saw ${JSON.stringify(s.S2)}`;
    return `WRONG  (${s1}, ${s2})`;
};

// The runner runs *inside* each impl's iframe. probes.js (loaded alongside the
// impl) defines window.runProbes; we just hand it the uniform interface every
// implementation exposes on window (install / uninstall / effect / getCurrent,
// plus an optional rpc() the naive strategy needs) and post the result back.
// Sharing probes.js keeps this in lockstep with test/test.js.
function runnerSource() {
    return `
    (async () => {
      try {
        install();
        const out = await runProbes({
          effect: window.effect,
          getCurrent: window.getCurrent,
          rpc: window.rpc,
          effectCancellable: window.effectCancellable,
        });
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
      <script src="probes.js"><\/script>
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
        // Every probe verdict is a definite pass or fail: green if it says OK,
        // red otherwise (WRONG / ERROR / LOST / LEAK / SHARED). No neutral state
        // — an impl that misses a part's ideal fails that part, exactly as
        // Part C already shows for the impls that can't solve bare composition.
        div.className = 'log ' + (msg.includes('OK') ? 'ok' : 'wrong');
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
        line('PART E  shared promise, two scopes ' + everdict(data.out.E), 'E');
        line('PART F  cancel S1, S2 same await   ' + fverdict(data.out.F), 'F');
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

const SCEN = Scenarios.SCEN; // single source: scenarios.js

// Browser-scaled work sizes (bench-one uses 100k / 5k; that would freeze a tab
// for far too long). Everything else mirrors bench-one.js exactly.
const BENCH_CFG = { N: 20000, N_RPC: 800, RUNS: 5 };

// Shared prelude injected into every bench iframe: the scenario table and the
// median-of-RUNS measurement loop, parameterised by (P, effectFn) just like
// bench-one's mkScenarios / measureAll.
function benchPrelude() {
    // The scenarios themselves come from scenarios.js (loaded as a <script> in
    // the iframe); only the sizes + timing loop live here.
    return `
    const { N, N_RPC, RUNS } = ${JSON.stringify(BENCH_CFG)};
    const work = (iters) => { let x = 0; for (let j = 0; j < iters; j++) x += j * j; return x; };
    async function measureAll(P, effectFn) {
      const out = {};
      const scenarios = Scenarios.mkScenarios(P, effectFn, N, N_RPC, work);
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
      <script src="scenarios.js"><\/script>
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
