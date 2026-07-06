// ═══ INSTRUMENTED VERSION FOR THE ODOO BOOT BENCHMARK ═══
// Deploy: copy this file over
//   <odoo>/addons/web/static/src/core/utils/cancellablePromise.js
// on the master-contextual-promise-nby branch (restore with git afterwards).
// The asset bundle regenerates automatically on the next page load.
//
// localStorage.cpImpl selects the implementation before boot:
//   "off"   → no patching at all (pristine native promises)
//   "proxy" → the branch's original Proxy + global-then implementation (default)
//   "v4"    → optimized own-property implementation
// window.__cpCount() reports how many promise operations went through the
// patch during the page's lifetime (scale of what is being measured).
const MODE = (() => {
    try { return localStorage.getItem("cpImpl") || "proxy"; } catch { return "proxy"; }
})();
window.__cpMode = MODE;
let CP_COUNT = 0;
window.__cpCount = () => CP_COUNT;

const execContexts = [];
const OriginalPromise = Promise;
const originalThen = Promise.prototype.then;

export const _exec = (execContext, cb, args) => {
    if (execContext?.cancelled) {
        return;
    }
    execContexts.push(execContext);
    const r = cb(...args);
    originalThen.call(
        OriginalPromise.resolve(),
        () => {
            execContexts.pop();
        },
        undefined
    );
    return r;
};

export const effect = (cb) => {
    const context = { cancelled: false };
    execContexts.push(context);
    cb();
    execContexts.pop();
    return {
        cancel: () => (context.cancelled = true),
        get isCancel() {
            return context.cancelled;
        },
    };
};

if (MODE === "proxy") {
    window.Promise = new Proxy(OriginalPromise, {
        construct(target, args, newTarget) {
            const instance = Reflect.construct(target, args, newTarget);
            CP_COUNT++;
            instance.execContext = execContexts.at(-1);
            return instance;
        },
        get(target, prop, receiver) {
            if (
                typeof target[prop] === "function" &&
                ["resolve", "reject", "all", "race", "allSettled", "any"].includes(prop)
            ) {
                return function (...args) {
                    const newPromise = Reflect.apply(target[prop], target, args);
                    CP_COUNT++;
                    newPromise.execContext = execContexts.at(-1);
                    return newPromise;
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });

    OriginalPromise.prototype.then = function (onFulfilled, onRejected) {
        CP_COUNT++;
        return originalThen.call(
            this,
            onFulfilled ? (...args) => _exec(this.execContext, onFulfilled, args) : undefined,
            onRejected ? (...args) => _exec(this.execContext, onRejected, args) : undefined
        );
    };
} else if (MODE === "v4") {
    class ExecContext {
        constructor(scopeName) {
            this.cancelled = false;
            this.scopeName = scopeName;
        }
    }
    const stampIfTracked = (p) => {
        CP_COUNT++;
        const ctx = execContexts[execContexts.length - 1];
        if (ctx !== undefined) {
            p.constructor = ctx;
            p.then = patchedThen;
        }
        return p;
    };
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
    const _exec4 = (ctx, cb, v, sandwich) => {
        if (ctx.cancelled) return;
        execContexts.push(ctx);
        if (sandwich) {
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
            return originalThen.call(this, onFulfilled, onRejected);
        }
        const wrapF = typeof onFulfilled === "function";
        const wrapR = typeof onRejected === "function";
        const sandwich = wrapF && wrapR;
        const derived = originalThen.call(
            this,
            wrapF ? (v) => _exec4(ctx, onFulfilled, v, sandwich) : onFulfilled,
            wrapR ? (e) => _exec4(ctx, onRejected, e, sandwich) : onRejected
        );
        derived.constructor = ctx;
        derived.then = patchedThen;
        return derived;
    };
    function PatchedPromise(executor) {
        return stampIfTracked(new OriginalPromise(executor));
    }
    PatchedPromise.prototype = OriginalPromise.prototype;
    PatchedPromise.resolve = (v) => stampIfTracked(OriginalPromise.resolve(v));
    PatchedPromise.reject = (e) => stampIfTracked(OriginalPromise.reject(e));
    PatchedPromise.race = (i) => stampIfTracked(OriginalPromise.race(i));
    PatchedPromise.allSettled = (i) => stampIfTracked(OriginalPromise.allSettled(i));
    PatchedPromise.any = (i) => stampIfTracked(OriginalPromise.any(i));
    PatchedPromise.all = (i) => stampIfTracked(OriginalPromise.all(i));
    if (OriginalPromise.withResolvers) {
        PatchedPromise.withResolvers = () => {
            const o = OriginalPromise.withResolvers();
            stampIfTracked(o.promise);
            return o;
        };
    }
    if (OriginalPromise.try) {
        PatchedPromise.try = (fn, ...args) => stampIfTracked(OriginalPromise.try(fn, ...args));
    }
    window.Promise = PatchedPromise;
}
