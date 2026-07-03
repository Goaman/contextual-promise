function logger(panelId) {
    const el = document.getElementById(panelId);
    return (msg) => {
        const div = document.createElement('div');
        div.className = 'log' + (msg.includes('OK') ? ' ok' : msg.includes('WRONG') ? ' wrong' : ' muted');
        div.textContent = msg;
        el.appendChild(div);
        console.log(`[${panelId}]`, msg);
    };
}

const verdict = (s) =>
    s.S1 === 'S1' && s.S2 === 'S2'
        ? 'OK'
        : `WRONG  (S1 saw "${s.S1}", S2 saw "${s.S2}")`;

// ── NAIVE rpc() (colleague strategy) ────────────────────────────────────────
async function demoNaive(log) {
    const stack = [];
    const cur = () => stack[stack.length - 1];

    function rpc() {
        const captured = cur();
        const real = Promise.resolve();
        return {
            then(onF, onR) {
                return real.then((v) => {
                    stack.push(captured);
                    const r = onF ? onF(v) : v;
                    Promise.resolve().then(() => stack.pop());
                    return r;
                }, onR);
            },
        };
    }

    function seeded(scope, fn) {
        stack.push(scope);
        try { return fn(); } finally { stack.pop(); }
    }

    {
        const seen = {};
        const a = seeded('S1', () => rpc().then(() => (seen.S1 = cur())));
        const b = seeded('S2', () => rpc().then(() => (seen.S2 = cur())));
        await Promise.all([a, b]);
        log('PART A  .then(callback):  ' + verdict(seen));
    }
    {
        const seen = {};
        const a = seeded('S1', () => (async () => { await rpc(); seen.S1 = cur(); })());
        const b = seeded('S2', () => (async () => { await rpc(); seen.S2 = cur(); })());
        await Promise.all([a, b]);
        log('PART B  async/await:      ' + verdict(seen));
    }
}

// ── CONTEXTUAL PROMISE (repo implementation) ─────────────────────────────────
async function demoContextual(log) {
    function rpc() {
        return Promise.resolve();
    }

    install();
    {
        const seen = {};
        const a = effect('S1', () => rpc().then(() => (seen.S1 = getCurrent())));
        const b = effect('S2', () => rpc().then(() => (seen.S2 = getCurrent())));
        await Promise.all([a, b]);
        log('PART A  .then(callback):  ' + verdict(seen));
    }
    {
        const seen = {};
        const a = effect('S1', () => (async () => { await rpc(); seen.S1 = getCurrent(); })());
        const b = effect('S2', () => (async () => { await rpc(); seen.S2 = getCurrent(); })());
        await Promise.all([a, b]);
        log('PART B  async/await:      ' + verdict(seen));
    }
    uninstall();
}

(async () => {
    const logNaive = logger('naive');
    const logCtx   = logger('contextual');
    uninstall();
    await demoNaive(logNaive);
    await demoContextual(logCtx);
})();
