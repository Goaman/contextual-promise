const execContexts = [];

const NativePromise = Promise;
const nativeThen = Promise.prototype.then;

// Stamping an *own* `constructor` property defeats the PromiseResolve fast
// path: `await p` does Get(p, "constructor") and, on a SameValue mismatch
// with %Promise%, falls back to calling p.then(...) — our patched then —
// instead of hooking the native internals directly (which would bypass us).
const stamp = (p) => {
    p.execContext = execContexts.at(-1);
    p.constructor = patchedPromise;
    return p;
};

const patchedPromise = new Proxy(NativePromise, {
    construct(target, args, newTarget) {
        return stamp(Reflect.construct(target, args, newTarget));
    },
    get(target, prop, receiver) {
        if (
            typeof target[prop] === "function" &&
            ["resolve", "reject", "all", "race", "allSettled", "any"].includes(prop)
        ) {
            return function (...args) {
                return stamp(Reflect.apply(target[prop], target, args));
            };
        }
        return Reflect.get(target, prop, receiver);
    },
});

const patchedThen = function (onFulfilled, onRejected) {
    const execContext = this.execContext;
    const derived = nativeThen.call(
        this,
        onFulfilled ? (...args) => _exec(execContext, onFulfilled, args) : undefined,
        onRejected  ? (...args) => _exec(execContext, onRejected,  args) : undefined
    );
    derived.execContext = execContext ?? derived.execContext;
    derived.constructor = patchedPromise;
    return derived;
};

const _exec = (execContext, cb, args) => {
    if (execContext?.cancelled) return;
    // `cb` may enqueue microtasks that must observe this context — e.g. when
    // `cb` is the internal resolve function of an `await`, calling it enqueues
    // the async function's resumption. The queue is FIFO, so a push job
    // enqueued before the call and a pop job enqueued after bracket exactly
    // the jobs `cb` enqueues. The synchronous push/pop covers `cb` itself.
    execContexts.push(execContext);
    queueMicrotask(() => execContexts.push(execContext));
    try {
        return cb(...args);
    } finally {
        queueMicrotask(() => execContexts.pop());
        execContexts.pop();
    }
};

window.install = () => {
    window.Promise = patchedPromise;
    Promise.prototype.then = patchedThen;
};

window.uninstall = () => {
    window.Promise = NativePromise;
    Promise.prototype.then = nativeThen;
};

window.effect = (scopeName, fn) => {
    const context = { cancelled: false, scopeName };
    execContexts.push(context);
    try { return fn(); } finally { execContexts.pop(); }
};

window.getCurrent = () => execContexts.at(-1)?.scopeName;

// Install by default
install();
