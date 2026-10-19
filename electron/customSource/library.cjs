// electron/customSource/library.cjs
// The modules a custom source script may `require`, and the lookup that hands them out.
//
// MusicFree plugins are CommonJS: they call `require('axios')`, `require('cheerio')` and a few
// others. Those names must resolve inside the script's own Function scope, which has no Node
// `require`, so the loader passes this table's lookup instead. A name that is not here fails the
// same way Node's own resolution would ("Cannot find module ..."), which is what a plugin author
// expects to see when they reach for something we do not ship.
//
// Everything is resolved once, at require time of this file, so a plugin calling `require` in a
// hot path costs a map lookup. A module that is missing from the installation (an optional
// dependency that did not build) is left out of the table rather than crashing the loader: the
// plugin that needs it fails to load, and every other plugin still works.

'use strict';

// The table of names. A module is required lazily on first use and cached, so an app that never
// loads a plugin pays nothing for the ones it does not use, and a module that throws on load
// (a native addon on an unsupported platform) takes down only the plugin that asked for it.
const MODULE_FACTORIES = {
    axios: () => require('axios'),
    cheerio: () => require('cheerio'),
    'crypto-js': () => require('crypto-js'),
    qs: () => require('qs'),
    'big-integer': () => require('big-integer'),
    he: () => require('he'),
    dayjs: () => require('dayjs'),
    webdav: () => require('webdav'),
    'iconv-lite': () => require('iconv-lite'),
    // Node built-ins some plugins reach for. They are real modules, not shims, because the script
    // runs in the main process where those are available.
    crypto: () => require('crypto'),
    url: () => require('url'),
    querystring: () => require('querystring'),
    buffer: () => require('buffer'),
    util: () => require('util'),
};

const cache = new Map();
const unavailable = new Map();

/**
 * Resolves one module name the way a plugin's `require` would.
 *
 * MusicFree hands each module back with `default` pointing at itself, because plugins are written
 * against both the CommonJS shape (`require('dayjs')`) and the ES one (`import dayjs from`), and the
 * Babel output of the latter reads `.default`. Doing the same here keeps a plugin that uses either
 * form working without a translation step.
 */
const loadModule = (name) => {
    if (cache.has(name)) return cache.get(name);
    if (unavailable.has(name)) throw new Error(`Cannot find module '${name}'`);

    const factory = MODULE_FACTORIES[name];
    if (!factory) {
        unavailable.set(name, true);
        throw new Error(`Cannot find module '${name}'`);
    }

    let module;
    try {
        module = factory();
    } catch (error) {
        // Remembered so the same failure is not retried (and re-logged) on every call.
        unavailable.set(name, error);
        throw new Error(`Cannot load module '${name}': ${error && error.message ? error.message : String(error)}`);
    }

    // Some of these are frozen or have a getter-only `default`; assigning is best-effort.
    try {
        if (module && typeof module === 'object' && !('default' in module)) {
            Object.defineProperty(module, 'default', { value: module, enumerable: false, configurable: true });
        }
    } catch {
        // A module that refuses the property still works through its CommonJS shape.
    }

    cache.set(name, module);
    return module;
};

/** Names a plugin may require. Sorted, for a stable message when one is missing. */
const availableModuleNames = () => Object.keys(MODULE_FACTORIES).sort();

/** Why a name is not available, or null when it is. For the loader's error text. */
const moduleUnavailableReason = (name) => {
    if (cache.has(name)) return null;
    if (!MODULE_FACTORIES[name]) return `not bundled: ${name}`;
    const failure = unavailable.get(name);
    return failure ? `failed to load: ${failure.message}` : null;
};

module.exports = { loadModule, availableModuleNames, moduleUnavailableReason };
