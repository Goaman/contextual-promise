// v5: the "constructor trap" — context survives BARE `await` on native
// promises we never created (async function results, fetch(), …), with
// awaiter-side (AsyncLocalStorage-style) semantics.
//
// v4's wall: an async function's implicit promise is allocated inside the
// engine, so it never passes through a tracked constructor, never gets a
// stamp, and `await blip()` sees `constructor === %Promise%` via the
// prototype and takes the internal fast path. But that lookup is OBSERVABLE:
// per spec, Await does PromiseResolve(%Promise%, value) which performs
// Get(value, "constructor") — and V8 only skips the Get while the promise
// @@species protector is intact (src/builtins/builtins-async-gen.cc, Await:
// "We can skip the 'constructor' lookup on {value} if its [[Prototype]] is
// the (initial) Promise.prototype and the @@species protector is intact").
// Own-property stamps already invalidate that protector, so every await
// already performs the real Get — v4 just answered it with the inherited
// %Promise% and waved the fast path through.
//
// So: make `Promise.prototype.constructor` an accessor. The getter runs
// SYNCHRONOUSLY inside Await, with `this` = the awaited promise, while the
// AWAITER's context is still on the exec stack — the exact moment and
// identity userland was "missing". If a context is ambient, record it on the
// promise, stamp an own `then`, and return the context: SameValue(ctx,
// %Promise%) fails, V8 allocates the wrapper and calls ResolvePromise, whose
// "then" lookup is observable once the then-protector is gone
// (src/builtins/promise-resolve.tq, ResolvePromise label Slow) — it finds our
// `then`, and the usual FIFO sandwich brackets the awaiter's resumption with
// the recorded context. If NO context is ambient, return %Promise%: the await
// stays on the native path and the resumption is deliberately NOT bracketed.
//
// That last point is the semantic fix over a naive trap. v4's await
// interception is resolver-side: the resumption inherits the context stored
// on the AWAITED promise, so `await someScopedPromise` from *outside* any
// scope infects the awaiter with the promise's scope (v4's tests only pass
// because the infection happens to die at the next bare native await — which
// a trap that propagates creation contexts keeps alive forever, compounding
// across every await). Awaiter-side capture is what AsyncLocalStorage /
// TC39 AsyncContext do: a continuation resumes in the context that was
// ambient WHEN IT SUSPENDED. `.then(cb)` chains keep v4's creation-context
// stamps (that's what effect-scope cancellation wants for callbacks).
//
// Costs & limitations:
// - The accessor forces the observable Get on every await isolate-wide (the
//   species protector is gone anyway once anything is stamped) — one JS
//   getter call per await even outside any scope. Measure with bench/.
// - `p.constructor === Promise` is false when read inside an active scope
//   (the getter answers with the context object; outside scopes it answers
//   %Promise%, which is better than v4's stamped-forever answer).
// - Two different scopes awaiting the SAME promise in the same synchronous
//   burst: the single pending-context slot means the second capture wins for
//   both resumptions. (A per-promise queue would fix it; not worth it here.)

const execContexts = [];

const NativePromise = Promise;
const nativeThen = NativePromise.prototype.then;

class ExecContext {
    constructor(scopeName) {
        this.cancelled = false;
        this.scopeName = scopeName;
    }
}

// Creation-time context (userland .then chains) and await-time context
// (pending, consumed by the thenable job's two-handler then call). Own
// symbol properties — `constructor` stays free for the prototype accessor.
const CTX = Symbol("ctx");
const AWAIT_CTX = Symbol("awaitCtx");

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
        // Awaiter has a context: record it for the imminent
        // PromiseResolveThenableJob and derail the fast path.
        this[AWAIT_CTX] = ctx;
        this.then = patchedThen;
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
// context for `.then` callbacks. Unlike v4 there is no own `constructor`
// stamp: await interception is the prototype accessor's job now, and it
// decides per-await, not per-promise. ExecContext has no Symbol.species, so
// SpeciesConstructor still falls back to %Promise% wherever the accessor's
// return value leaks into a species lookup.
const stampIfTracked = (p) => {
    const ctx = execContexts[execContexts.length - 1];
    if (ctx !== undefined) {
        p[CTX] = ctx;
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
    const wrapF = typeof onFulfilled === "function";
    const wrapR = typeof onRejected === "function";
    // A (resolve, reject) pair of functions is the await machinery's
    // signature (PromiseResolveThenableJob): consume the await-time context
    // recorded by the constructor trap and bracket the resumption jobs with
    // the queued sandwich. Single-handler user chains use the creation
    // context and skip the two extra microtasks.
    let ctx;
    let sandwich = false;
    if (wrapF && wrapR) {
        sandwich = true;
        ctx = this[AWAIT_CTX];
        if (ctx !== undefined) this[AWAIT_CTX] = undefined;
        else ctx = this[CTX];
    } else {
        ctx = this[CTX];
    }
    if (!(ctx instanceof ExecContext)) {
        return nativeThen.call(this, onFulfilled, onRejected);
    }
    const derived = nativeThen.call(
        this,
        wrapF ? (v) => _exec(ctx, onFulfilled, v, sandwich) : onFulfilled,
        wrapR ? (e) => _exec(ctx, onRejected, e, sandwich) : onRejected
    );
    derived[CTX] = ctx;
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
// constructor trap) — lets the test suite assert Part G.
window.SUPPORTS_BARE_AWAIT_COMPOSITION = true;

// Install by default
install();
