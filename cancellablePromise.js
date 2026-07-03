const execContexts = [];

const NativePromise = Promise;
const nativeThen = Promise.prototype.then;

const patchedPromise = new Proxy(NativePromise, {
    construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);
        instance.execContext = execContexts.at(-1);
        return instance;
    },
    get(target, prop, receiver) {
        if (
            typeof target[prop] === "function" &&
            ["resolve", "reject", "all", "race", "allSettled", "any"].includes(prop)
        ) {
            return function (...args) {
                const p = Reflect.apply(target[prop], target, args);
                p.execContext = execContexts.at(-1);
                return p;
            };
        }
        return Reflect.get(target, prop, receiver);
    },
});

const patchedThen = function (onFulfilled, onRejected) {
    return nativeThen.call(
        this,
        onFulfilled ? (...args) => _exec(this.execContext, onFulfilled, args) : undefined,
        onRejected  ? (...args) => _exec(this.execContext, onRejected,  args) : undefined
    );
};

const _exec = (execContext, cb, args) => {
    if (execContext?.cancelled) return;
    execContexts.push(execContext);
    const r = cb(...args);
    nativeThen.call(NativePromise.resolve(), () => execContexts.pop(), undefined);
    return r;
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
