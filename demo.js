// Drives every implementation in implementations/ through the same two probes
// and renders a verdict panel for each. Each implementation is loaded in its
// own iframe so the files' top-level `const`s and window-global installs stay
// isolated from one another (and it works straight off file://).

const IMPLS = [
    { name: 'naive rpc() (colleague strategy)', path: 'implementations/naive.js' },
    { name: '00-original.js  (v4)', path: 'implementations/00-original.js' },
    { name: '01-proxy.js  (v1)', path: 'implementations/01-proxy.js' },
    { name: '02-subclass.js  (v2)', path: 'implementations/02-subclass.js' },
    { name: '03-single-stamp.js  (v3)', path: 'implementations/03-single-stamp.js' },
    { name: '04-v4-sandwich-always.js', path: 'implementations/04-v4-sandwich-always.js' },
    { name: '05-constructor-trap.js  (v5, awaiter-side)', path: 'implementations/05-constructor-trap.js' },
];

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

    const line = (msg) => {
        const div = document.createElement('div');
        div.className = 'log ' + (msg.includes('OK') ? 'ok' : /WRONG|ERROR|LOST|LEAK/.test(msg) ? 'wrong' : 'muted');
        div.textContent = msg;
        body.appendChild(div);
        console.log(`[${impl.path}]`, msg);
    };

    if (data.error) {
        line('ERROR  ' + data.error.split('\n')[0]);
    } else {
        line('PART A  .then(callback):          ' + verdict(data.out.A));
        line('PART B  async/await:              ' + verdict(data.out.B));
        line('PART C  await blip() (bare):      ' + cverdict(data.out.Cbare));
        line('PART C  await Promise.resolve(…): ' + cverdict(data.out.Crestamp));
        line('PART D  await scoped from outside ' + dverdict(data.out.D));
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
