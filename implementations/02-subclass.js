const execContexts = [];

const NativePromise = Promise;
const nativeThen = NativePromise.prototype.then;

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
    if (ctx !== undefined && ctx.cancelled) return;
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

class ContextPromise extends NativePromise {
    constructor(executor) {
        super(executor);
        // Instances inherit `constructor` === ContextPromise, which already
        // fails PromiseResolve's SameValue check with %Promise%: `await p`
        // takes the thenable route and calls this.then(...) instead of the
        // native internals (which would bypass us). No own-property stamp,
        // no global prototype patch — V8's promise protectors stay intact,
        // so untouched native promises keep their fast paths.
        this.execContext = execContexts[execContexts.length - 1];
    }

    then(onFulfilled, onRejected) {
        const ctx = this.execContext;
        if (ctx === undefined && execContexts.length === 0) {
            return super.then(onFulfilled, onRejected);
        }
        const wrapF = typeof onFulfilled === "function";
        const wrapR = typeof onRejected === "function";
        // The queued sandwich is only needed when the callback can enqueue a
        // native continuation that must inherit the context. The await
        // machinery (PromiseResolveThenableJob) always passes a
        // (resolve, reject) pair; user chains overwhelmingly pass one
        // handler per link, so they skip the two extra microtasks.
        const sandwich = wrapF && wrapR;
        const derived = super.then(
            wrapF ? (v) => _exec(ctx, onFulfilled, v, sandwich) : onFulfilled,
            wrapR ? (e) => _exec(ctx, onRejected, e, sandwich) : onRejected
        );
        if (derived.execContext === undefined) derived.execContext = ctx;
        return derived;
    }

    // Native all() would Invoke every element's patched then with a
    // (resolve, reject) pair — paying wrappers plus the queued sandwich per
    // element. The aggregation callbacks never need the ambient context (the
    // continuation on the all-promise itself is still tracked), so attach
    // them through the native then instead.
    static all(items) {
        const arr = Array.from(items);
        return new this((resolve, reject) => {
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
                    NativePromise.resolve(item).then(
                        (v) => { out[i] = v; if (--remaining === 0) resolve(out); },
                        reject
                    );
                } else {
                    out[i] = item;
                    if (--remaining === 0) resolve(out);
                }
            }
        });
    }
}

window.install = () => {
    window.Promise = ContextPromise;
};

window.uninstall = () => {
    window.Promise = NativePromise;
};

window.effect = (scopeName, fn) => {
    const context = { cancelled: false, scopeName };
    execContexts.push(context);
    try { return fn(); } finally { execContexts.pop(); }
};

// Like effect(), but returns { result, cancel }: cancel() flips the scope's
// `cancelled` flag, after which wrapped continuations bracketed by this scope
// are skipped — the lib's skip-callback cancellation (probe Part F).
window.effectCancellable = (scopeName, fn) => {
    const context = { cancelled: false, scopeName };
    execContexts.push(context);
    try {
        return { result: fn(), cancel: () => { context.cancelled = true; } };
    } finally {
        execContexts.pop();
    }
};

window.getCurrent = () => execContexts[execContexts.length - 1]?.scopeName;

// Install by default
install();
