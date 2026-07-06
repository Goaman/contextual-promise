// v6: v5 + "one-shot then" — per-AWAITER context, even when several scopes
// await the SAME shared promise (demo Part E).
//
// v5's limitation: the constructor trap captures the awaiter's context into a
// single slot on the promise, consumed later by the thenable JOB. Two scopes
// awaiting one shared promise in the same synchronous burst both enqueue jobs
// before either runs, so the second capture overwrites the first: the slot is
// per-promise, but the context is per-AWAIT.
//
// The fix rides on an ordering guarantee the spec hands us: each await's
// suspension sequence is SYNCHRONOUS and atomic —
//
//   Get(value, "constructor")   ← constructor trap fires, awaiter ctx ambient
//   NewJSPromise (wrapper)
//   ResolvePromise(wrapper, value)
//     Get(value, "then")        ← still the SAME awaiter's sync window
//     enqueue PromiseResolveThenableJob(wrapper, value, thenAction)
//
// (V8: src/builtins/builtins-async-gen.cc `Await` + promise-resolve.tq
// `ResolvePromise` label Slow — both Gets are observable once the species /
// then protectors are gone, which our stamps already ensure.)
//
// So make the promise's own `then` an ACCESSOR too. The constructor trap
// still parks the awaiter's context on the promise, but the `then` getter
// consumes it immediately — within the same awaiter's synchronous sequence,
// before any other awaiter can touch it — and returns a ONE-SHOT closure
// carrying that context. The enqueued job holds the closure, not a shared
// slot: N awaiters of one promise get N closures, each bracketing its own
// resumption with its own scope. Userland `.then()` reads see an empty slot
// and get the ordinary patched then (creation-context semantics, as v4/v5).
//
// Slot hygiene: the native `then` also performs a species Get(constructor)
// on the receiver, which re-parks a context while inside a scope; every
// internal nativeThen call site clears the slot afterwards so a stale park
// can't leak into a later unrelated `then` read.

const execContexts = [];

const NativePromise = Promise;
const nativeThen = NativePromise.prototype.then;

class ExecContext {
    constructor(scopeName) {
        this.cancelled = false;
        this.scopeName = scopeName;
    }
}

// Creation-time context (userland .then chains) and the parked await-time
// context (constructor trap → consumed by the then trap within one await's
// synchronous suspension sequence).
const CTX = Symbol("ctx");
const AWAIT_CTX = Symbol("awaitCtx");

const hasOwn = Object.prototype.hasOwnProperty;

// Own `then` accessor: consumes the context the constructor trap parked
// during THIS await's synchronous sequence and binds it into a one-shot
// interceptor; with nothing parked it's an ordinary read of the patched then.
const thenTrap = {
    configurable: true,
    get() {
        const ctx = this[AWAIT_CTX];
        if (ctx !== undefined) {
            this[AWAIT_CTX] = undefined;
            const p = this;
            return (onFulfilled, onRejected) =>
                awaitIntercept(p, ctx, onFulfilled, onRejected);
        }
        return patchedThen;
    },
    set(v) {
        Object.defineProperty(this, "then", {
            value: v,
            writable: true,
            configurable: true,
        });
    },
};
const stampThen = (p) => Object.defineProperty(p, "then", thenTrap);

const ctorTrap = {
    configurable: true,
    get() {
        // Direct reads of Promise.prototype.constructor (or reads on
        // non-promises inheriting from it) stay transparent.
        if (!(this instanceof NativePromise)) return NativePromise;
        const ctx = execContexts[execContexts.length - 1];
        // No ambient context: answer %Promise% so SameValue passes and the
        // await stays fully native — the resumption belongs to no scope.
        if (ctx === undefined) return NativePromise;
        // Awaiter has a context: park it for the Get(value, "then") that
        // follows within this same synchronous suspension sequence.
        this[AWAIT_CTX] = ctx;
        if (!hasOwn.call(this, "then")) stampThen(this);
        return ctx;
    },
    // Keep plain `p.constructor = v` working (shadow with an own prop).
    set(v) {
        Object.defineProperty(this, "constructor", {
            value: v,
            writable: true,
            configurable: true,
        });
    },
};

// A promise created through a tracked constructor/static carries its creation
// context for `.then` callbacks. ExecContext has no Symbol.species, so
// SpeciesConstructor falls back to %Promise% wherever a trap's return value
// leaks into a species lookup.
const stampIfTracked = (p) => {
    const ctx = execContexts[execContexts.length - 1];
    if (ctx !== undefined) {
        p[CTX] = ctx;
        stampThen(p);
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

// The await path: called by the PromiseResolveThenableJob through a one-shot
// closure that carries the awaiter's context. Always sandwiched — the
// (resolve, reject) pair only enqueues the real resumption. The job ignores
// our return value, so no derived stamping is needed.
const awaitIntercept = (p, ctx, onFulfilled, onRejected) => {
    const r = nativeThen.call(
        p,
        typeof onFulfilled === "function"
            ? (v) => _exec(ctx, onFulfilled, v, true)
            : onFulfilled,
        typeof onRejected === "function"
            ? (e) => _exec(ctx, onRejected, e, true)
            : onRejected
    );
    if (p[AWAIT_CTX] !== undefined) p[AWAIT_CTX] = undefined; // species-Get park
    return r;
};

const patchedThen = function (onFulfilled, onRejected) {
    const ctx = this[CTX];
    if (!(ctx instanceof ExecContext)) {
        const r = nativeThen.call(this, onFulfilled, onRejected);
        if (this[AWAIT_CTX] !== undefined) this[AWAIT_CTX] = undefined;
        return r;
    }
    const wrapF = typeof onFulfilled === "function";
    const wrapR = typeof onRejected === "function";
    // Real awaits never reach here (they consume a one-shot closure), so the
    // pair-of-functions case is a user-facing two-handler then / .finally():
    // sandwiched with the CREATION context, exactly as in v4/v5.
    const sandwich = wrapF && wrapR;
    const derived = nativeThen.call(
        this,
        wrapF ? (v) => _exec(ctx, onFulfilled, v, sandwich) : onFulfilled,
        wrapR ? (e) => _exec(ctx, onRejected, e, sandwich) : onRejected
    );
    if (this[AWAIT_CTX] !== undefined) this[AWAIT_CTX] = undefined;
    derived[CTX] = ctx;
    stampThen(derived);
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
        const settle = (item, i) => {
            nativeThen.call(
                item,
                (v) => { out[i] = v; if (--remaining === 0) resolve(out); },
                reject
            );
            if (item[AWAIT_CTX] !== undefined) item[AWAIT_CTX] = undefined;
        };
        for (let i = 0; i < arr.length; i++) {
            const item = arr[i];
            if (item instanceof NativePromise) {
                settle(item, i);
            } else if (item !== null && typeof item?.then === "function") {
                settle(NativePromise.resolve(item), i);
            } else {
                out[i] = item;
                if (--remaining === 0) resolve(out);
            }
        }
    });
};

const ORIG_CTOR_DESC = Object.getOwnPropertyDescriptor(
    NativePromise.prototype,
    "constructor"
);

window.install = () => {
    window.Promise = PatchedPromise;
    Object.defineProperty(NativePromise.prototype, "constructor", ctorTrap);
    // The whole scheme assumes V8's protector-guarded shortcuts are OFF:
    // Await must do the observable constructor Get (species protector) and
    // ResolvePromise must do the observable then Get (then protector). Both
    // die on the first own-property stamp anyway; kill them deterministically
    // so the very first await in a scope is already interceptable.
    const dummy = new NativePromise(() => {});
    dummy.then = null;
    dummy.constructor = null;
};

window.uninstall = () => {
    window.Promise = NativePromise;
    Object.defineProperty(
        NativePromise.prototype,
        "constructor",
        ORIG_CTOR_DESC
    );
};

window.effect = (scopeName, fn) => {
    const context = new ExecContext(scopeName);
    execContexts.push(context);
    try { return fn(); } finally { execContexts.pop(); }
};

window.getCurrent = () => execContexts[execContexts.length - 1]?.scopeName;

// Context survives a bare `await` on an untracked native promise (the
// constructor trap), and each awaiter of a SHARED promise resumes in its own
// scope (the one-shot then) — lets the suite assert Parts C-bare, D and E.
window.SUPPORTS_BARE_AWAIT_COMPOSITION = true;
window.SUPPORTS_PER_AWAITER_CONTEXT = true;

// Install by default
install();
