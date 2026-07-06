// v6 "one-shot then": full mechanism and V8/JSC/SpiderMonkey source citations
// in README.md ("The second wall", "Per-awaiter context", "Portability").
// In short — both `Promise.prototype.constructor` and each touched promise's
// own `then` are accessors. An await's suspension sequence is synchronous and
// atomic (Get constructor → wrapper → ResolvePromise → Get then → enqueue
// job), so the constructor getter parks the AWAITER's ambient context on the
// promise and the then getter consumes it within that same window, handing
// the thenable job a one-shot closure per awaiter. No ambient context →
// answer %Promise% and the await stays fully native. Userland `.then()` finds
// an empty park and keeps creation-context semantics (v4). Syntax/API floor
// is ES2017 (async/await baseline: Chrome 55, Safari 10.1, Firefox 52).

const execContexts = [];
const NativePromise = Promise;
const nativeThen = NativePromise.prototype.then;
const hasOwn = Object.prototype.hasOwnProperty;

// queueMicrotask (2019) fallback: reaction jobs on a pristine pre-install
// promise share the same FIFO microtask queue per the HTML spec.
const microtaskSource = NativePromise.resolve();
const queueJob = typeof queueMicrotask === "function"
    ? queueMicrotask
    : (job) => nativeThen.call(microtaskSource, job);

class ExecContext {
    constructor(scopeName) {
        this.cancelled = false;
        this.scopeName = scopeName;
    }
}

const CTX = Symbol("ctx");            // creation context (userland .then chains)
const AWAIT_CTX = Symbol("awaitCtx"); // parked awaiter context (one await's sync window)

// Shadow the prototype accessor with a plain own data property, so userland
// `p.then = fn` / `p.constructor = v` assignments keep working.
const shadow = (obj, key, value) =>
    Object.defineProperty(obj, key, { value, writable: true, configurable: true });

// The native then also species-Gets the receiver's constructor, re-parking a
// context while inside a scope: internal call sites clear the park after.
const clearPark = (p) => {
    if (p[AWAIT_CTX] !== undefined) p[AWAIT_CTX] = undefined;
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
        queueJob(pushJob);
    }
    try {
        return cb(v);
    } finally {
        if (sandwich) queueJob(popJob);
        execContexts.pop();
    }
};

const wrap = (ctx, cb, sandwich) =>
    typeof cb === "function" ? (v) => _exec(ctx, cb, v, sandwich) : cb;

const attach = (p, ctx, onF, onR, sandwich) =>
    nativeThen.call(p, wrap(ctx, onF, sandwich), wrap(ctx, onR, sandwich));

// The await path: called by the thenable job through a one-shot closure
// carrying the awaiter's context. Always sandwiched — the (resolve, reject)
// pair only enqueues the real resumption; the job ignores our return value.
const awaitIntercept = (p, ctx, onF, onR) => {
    const derived = attach(p, ctx, onF, onR, true);
    clearPark(p);
    return derived;
};

// Real awaits never reach here (they consume a one-shot closure), so a pair
// of function handlers is a user-facing two-handler then / .finally():
// sandwiched with the CREATION context, exactly as in v4/v5.
const patchedThen = function (onFulfilled, onRejected) {
    const ctx = this[CTX];
    if (!(ctx instanceof ExecContext)) {
        const derived = nativeThen.call(this, onFulfilled, onRejected);
        clearPark(this);
        return derived;
    }
    const sandwich = typeof onFulfilled === "function" && typeof onRejected === "function";
    const derived = attach(this, ctx, onFulfilled, onRejected, sandwich);
    clearPark(this);
    derived[CTX] = ctx;
    stampThen(derived);
    return derived;
};

// Own `then` accessor: consume the context the constructor trap parked during
// THIS await's synchronous sequence into a one-shot interceptor; with nothing
// parked it's an ordinary read of the patched then.
const thenTrap = {
    configurable: true,
    get() {
        const ctx = this[AWAIT_CTX];
        if (ctx === undefined) return patchedThen;
        this[AWAIT_CTX] = undefined;
        const p = this;
        return (onF, onR) => awaitIntercept(p, ctx, onF, onR);
    },
    set(v) { shadow(this, "then", v); },
};
const stampThen = (p) => Object.defineProperty(p, "then", thenTrap);

const ctorTrap = {
    configurable: true,
    get() {
        if (!(this instanceof NativePromise)) return NativePromise;
        const ctx = execContexts[execContexts.length - 1];
        if (ctx === undefined) return NativePromise; // no scope: stay fully native
        this[AWAIT_CTX] = ctx;                       // park for the imminent then-Get
        if (!hasOwn.call(this, "then")) stampThen(this);
        return ctx;                                  // ≠ %Promise% → thenable route
    },
    set(v) { shadow(this, "constructor", v); },
};

// Promises created through a tracked constructor/static carry their creation
// context for `.then` callbacks. ExecContext has no Symbol.species, so
// species lookups seeing a trap's return value fall back to %Promise%.
const stampIfTracked = (p) => {
    const ctx = execContexts[execContexts.length - 1];
    if (ctx !== undefined) {
        p[CTX] = ctx;
        stampThen(p);
    }
    return p;
};

function PatchedPromise(executor) {
    return stampIfTracked(new NativePromise(executor));
}
PatchedPromise.prototype = NativePromise.prototype;

PatchedPromise.resolve = (v) => stampIfTracked(NativePromise.resolve(v));
PatchedPromise.reject = (e) => stampIfTracked(NativePromise.reject(e));
for (const k of ["race", "allSettled", "any", "try"]) {
    if (NativePromise[k])
        PatchedPromise[k] = (...args) => stampIfTracked(NativePromise[k](...args));
}
if (NativePromise.withResolvers) {
    PatchedPromise.withResolvers = () => {
        const o = NativePromise.withResolvers();
        stampIfTracked(o.promise);
        return o;
    };
}

// Hand-rolled all(): native all() would re-resolve every tracked element
// through the slow thenable route (wrapper + sandwich per element), and the
// aggregation callbacks never need the ambient context — the all-promise
// itself is still tracked via its own stamp.
PatchedPromise.all = (items) =>
    new PatchedPromise((resolve, reject) => {
        const arr = Array.from(items);
        const out = new Array(arr.length);
        let remaining = arr.length;
        if (remaining === 0) return resolve(out);
        arr.forEach((item, i) => {
            const thenable = item instanceof NativePromise
                || (item != null && typeof item.then === "function");
            if (!thenable) {
                out[i] = item;
                if (--remaining === 0) resolve(out);
                return;
            }
            const p = item instanceof NativePromise ? item : NativePromise.resolve(item);
            nativeThen.call(p, (v) => {
                out[i] = v;
                if (--remaining === 0) resolve(out);
            }, reject);
            clearPark(p);
        });
    });

const ORIG_CTOR_DESC = Object.getOwnPropertyDescriptor(
    NativePromise.prototype,
    "constructor"
);

window.install = () => {
    window.Promise = PatchedPromise;
    Object.defineProperty(NativePromise.prototype, "constructor", ctorTrap);
    // Deterministically kill V8's species + then protectors (and their
    // JSC/SpiderMonkey equivalents die on the accessor above) so the very
    // first await in a scope is already interceptable.
    const dummy = new NativePromise(() => {});
    dummy.then = null;
    dummy.constructor = null;
};

window.uninstall = () => {
    window.Promise = NativePromise;
    Object.defineProperty(NativePromise.prototype, "constructor", ORIG_CTOR_DESC);
};

// cancel() flips the scope's flag; from then on _exec skips every
// continuation bracketed by this scope — skip-callback cancellation.
window.effectCancellable = (scopeName, fn) => {
    const context = new ExecContext(scopeName);
    execContexts.push(context);
    try {
        return { result: fn(), cancel: () => { context.cancelled = true; } };
    } finally {
        execContexts.pop();
    }
};

window.effect = (scopeName, fn) => window.effectCancellable(scopeName, fn).result;

window.getCurrent = () => {
    const ctx = execContexts[execContexts.length - 1];
    return ctx === undefined ? undefined : ctx.scopeName;
};

// Bare `await` on untracked natives keeps context (constructor trap); each
// awaiter of a shared promise resumes in its own scope (one-shot then).
window.SUPPORTS_BARE_AWAIT_COMPOSITION = true;
window.SUPPORTS_PER_AWAITER_CONTEXT = true;

// Install by default
install();
