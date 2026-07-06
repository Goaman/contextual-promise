const execContexts = [];

const NativePromise = Promise;
const nativeThen = NativePromise.prototype.then;

class ExecContext {
    constructor(scopeName) {
        this.cancelled = false;
        this.scopeName = scopeName;
    }
}

// A promise is marked as tracked by overwriting its own `constructor`
// property with its ExecContext. One own-property store does two jobs:
// (1) PromiseResolve's SameValue(Get(p, "constructor"), %Promise%) check
// fails, so `await p` takes the thenable route and calls our patched then
// instead of the native internals (which would bypass us); (2) the value IS
// the context — no second property. Because ExecContext has no
// Symbol.species, SpeciesConstructor(p) falls back to %Promise% and derived
// promises are still created through the fast native capability path.
// The patched then rides along as an own property too, so the global
// Promise.prototype is NEVER touched: untracked promises keep a fully
// native then with zero indirection, and `await` on them never sees us.
const stampIfTracked = (p) => {
    const ctx = execContexts[execContexts.length - 1];
    if (ctx !== undefined) {
        p.constructor = ctx;
        p.then = patchedThen;
    }
    return p;
};

// Contexts for pending push jobs — microtask FIFO keeps this in sync.
// Ring-style consumption: shift() would be O(n) with many pending jobs.
const pendingCtx = [];
let pendingHead = 0;
const pushJob = () => {
    execContexts.push(pendingCtx[pendingHead]);
    pendingCtx[pendingHead++] = undefined;
    if (pendingHead === pendingCtx.length) {
        pendingCtx.length = 0;
        pendingHead = 0;
    }
};
const popJob = () => execContexts.pop();

const _exec = (ctx, cb, v, sandwich) => {
    if (ctx.cancelled) return;
    execContexts.push(ctx);
    if (sandwich) {
        // `cb` may only *enqueue* the real continuation (an async function
        // resumes in a later microtask): bracket the jobs it enqueues with a
        // queued push/pop pair — FIFO order puts them right around those jobs.
        pendingCtx.push(ctx);
        queueMicrotask(pushJob);
    }
    try {
        return cb(v);
    } finally {
        if (sandwich) queueMicrotask(popJob);
        execContexts.pop();
    }
};

const patchedThen = function (onFulfilled, onRejected) {
    const ctx = this.constructor;
    if (!(ctx instanceof ExecContext)) {
        return nativeThen.call(this, onFulfilled, onRejected);
    }
    const wrapF = typeof onFulfilled === "function";
    const wrapR = typeof onRejected === "function";
    // The queued sandwich is only needed when the callback can enqueue a
    // native continuation that must inherit the context. The await machinery
    // (PromiseResolveThenableJob) always passes a (resolve, reject) pair;
    // user chains overwhelmingly pass one handler per link, so they skip the
    // two extra microtasks.
    const sandwich = wrapF || wrapR; // VARIANT: sandwich on every wrapped hop (worst case)
    const derived = nativeThen.call(
        this,
        wrapF ? (v) => _exec(ctx, onFulfilled, v, sandwich) : onFulfilled,
        wrapR ? (e) => _exec(ctx, onRejected, e, sandwich) : onRejected
    );
    derived.constructor = ctx;
    derived.then = patchedThen;
    return derived;
};

function PatchedPromise(executor) {
    return stampIfTracked(new NativePromise(executor));
}
PatchedPromise.prototype = NativePromise.prototype;

PatchedPromise.resolve = (v) => stampIfTracked(NativePromise.resolve(v));
PatchedPromise.reject = (e) => stampIfTracked(NativePromise.reject(e));
PatchedPromise.race = (i) => stampIfTracked(NativePromise.race(i));
PatchedPromise.allSettled = (i) => stampIfTracked(NativePromise.allSettled(i));
PatchedPromise.any = (i) => stampIfTracked(NativePromise.any(i));
if (NativePromise.withResolvers) {
    PatchedPromise.withResolvers = () => {
        const o = NativePromise.withResolvers();
        stampIfTracked(o.promise);
        return o;
    };
}
if (NativePromise.try) {
    PatchedPromise.try = (fn, ...args) =>
        stampIfTracked(NativePromise.try(fn, ...args));
}

// Native all() would re-resolve every tracked element through the slow
// thenable route and pay wrappers plus the queued sandwich per element. The
// aggregation callbacks never need the ambient context (continuations on the
// all-promise itself are still tracked via its stamp), so attach them through
// the native then instead.
PatchedPromise.all = function (items) {
    const arr = Array.from(items);
    return new PatchedPromise((resolve, reject) => {
        let remaining = arr.length;
        if (remaining === 0) return resolve([]);
        const out = new Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
            const item = arr[i];
            if (item instanceof NativePromise) {
                nativeThen.call(
                    item,
                    (v) => { out[i] = v; if (--remaining === 0) resolve(out); },
                    reject
                );
            } else if (item !== null && typeof item?.then === "function") {
                nativeThen.call(
                    NativePromise.resolve(item),
                    (v) => { out[i] = v; if (--remaining === 0) resolve(out); },
                    reject
                );
            } else {
                out[i] = item;
                if (--remaining === 0) resolve(out);
            }
        }
    });
};

window.install = () => {
    window.Promise = PatchedPromise;
};

window.uninstall = () => {
    window.Promise = NativePromise;
};

window.effect = (scopeName, fn) => {
    const context = new ExecContext(scopeName);
    execContexts.push(context);
    try { return fn(); } finally { execContexts.pop(); }
};

window.getCurrent = () => execContexts[execContexts.length - 1]?.scopeName;

// Install by default
install();
