// Naive "colleague strategy": DON'T patch Promise at all. Track context with a
// plain stack and hand out a custom `rpc()` thenable that does the FIFO
// microtask sandwich by hand. Works only for values that flow through this
// bespoke thenable — a real `Promise.resolve()` / `await` on a native promise
// is invisible to it. That's the whole contrast with the patched-Promise
// implementations, which propagate context through *any* promise.
const stack = [];
const cur = () => stack[stack.length - 1];

const rpc = () => {
    const captured = cur();
    const real = Promise.resolve();
    return {
        then(onF, onR) {
            return real.then((v) => {
                // Calling onF may only *enqueue* the real continuation (an async
                // function resumes in a later microtask), so bracket the jobs it
                // enqueues with a queued push/pop pair — FIFO order puts them
                // right around those jobs.
                stack.push(captured);
                queueMicrotask(() => stack.push(captured));
                try {
                    return onF ? onF(v) : v;
                } finally {
                    queueMicrotask(() => stack.pop());
                    stack.pop();
                }
            }, onR);
        },
    };
};

// No global Promise patch — install/uninstall are no-ops, present only so the
// demo harness can drive every implementation through one uniform interface.
window.install = () => {};
window.uninstall = () => {};

window.effect = (scopeName, fn) => {
    stack.push(scopeName);
    try { return fn(); } finally { stack.pop(); }
};

window.getCurrent = () => cur();

// The naive strategy only tracks context across ITS OWN thenable, so it must
// export the custom rpc(); the demo uses this in place of Promise.resolve().
window.rpc = rpc;
