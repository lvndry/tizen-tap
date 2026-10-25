'use strict';

// One cell whose value is only ever replaced. Functional core, imperative shell: this is the shell.
function createStore(initial) {
    let current = Object.freeze({ ...initial });

    function get() {
    return current;
}

    function update(patch) {
        const changes = typeof patch === 'function' ? patch(current) : patch;
        current = Object.freeze({ ...current, ...changes });
        return current;
    }

    function select(key) {
    return current[key];
}

    return { get, update, select };
}

module.exports = { createStore };
