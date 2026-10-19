import { loadModule } from './moduleTable';
// electron/customSource/loader.cjs
// Turns a custom source script's text into the object its methods are called on.
//
// A MusicFree plugin is a CommonJS module: it assigns to `module.exports` (or `exports.default`)
// and expects `require`, `console`, `env`, `URL` and `process` in scope. There is no module system
// to hand it to, so the text is wrapped in a function whose parameters are exactly those names and
// called with our own. This is the same shape MusicFree itself uses (pluginManager/plugin.ts,
// mountPlugin), which is why a plugin written for it runs here unmodified.
//
// What this is not: a sandbox. The script runs in the main process with this process's authority,
// exactly as MusicFree's runs with the app's. Only scripts the listener chose to install are loaded,
// and the settings page says so before the first one is added.
//
// The wrapper is built once per load. `new Function` is a compile, not an eval of a string with
// access to this scope: the body sees only the parameters listed, and `require` is our table
// lookup rather than Node's resolver.



/** Thrown for a script whose text cannot become a plugin at all. */
class CustomSourceLoadError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CustomSourceLoadError';
    }
}

// The parameters the wrapper is called with, in order. `__musicfree_require` is the same lookup as
// `require`: MusicFree passes its table twice, once under each name, and some plugins use either.
//
// `Buffer` 是浏览器版特有的：桌面版跑在 Node 里，Buffer 是全局；WebView 里没有，而插件会直接用它
// （汽水的取链就依赖它）。以参数注入的方式给出，插件里写 `Buffer.from(...)` 就能用。
const WRAPPER_PARAMETERS = ['require', '__musicfree_require', 'module', 'exports', 'console', 'env', 'URL', 'process', 'Buffer'];

/*
 * Builds the wrapper. `'use strict'` is inside the returned function so a plugin's own sloppy-mode
 * habits still work; it only forbids the wrapper's own implicit globals.
 */
const compileWrapper = (code) => {
    const source = `'use strict';\nreturn function(${WRAPPER_PARAMETERS.join(', ')}) {\n${code}\n};`;
    try {
        // eslint-disable-next-line no-new-func
        return new Function(source)();
    } catch (error) {
        throw new CustomSourceLoadError(`script does not compile: ${error && error.message ? error.message : String(error)}`);
    }
};

/** The `env` object a plugin reads for the listener's variables and the host's identity. */
const buildEnv = ({ getUserVariables }) => ({
    getUserVariables,
    get userVariables() {
        return getUserVariables() || {};
    },
    // The values MusicFree reports. A plugin that gates a feature on the app version is written
    // against MusicFree's numbering; claiming its own would switch features off for no reason.
    appVersion: '0.6.0',
    os: 'android',
    lang: 'zh-CN',
});

/**
 * Loads one script and returns the plugin object.
 *
 * `getUserVariables` answers the values the listener filled in for this source (MusicFree's
 * `userVariables` in the manifest); the loader keeps them, so a plugin that reads `env.userVariables`
 * sees them.
 */
const loadPlugin = (code, { getUserVariables = () => ({}) } = {}) => {
    if (typeof code !== 'string' || code.trim().length === 0) {
        throw new CustomSourceLoadError('script is empty');
    }

    const wrapper = compileWrapper(code);
    const module = { exports: {} };
    const env = buildEnv({ getUserVariables });

    const nodeRequire = (name) => loadModule(String(name));
    // The `process` a plugin sees is a plain object, not Node's: MusicFree gives plugins this same
    // small shape, and a plugin reading `process.platform` must not see the desktop's answer.
    const pluginProcess = { platform: 'android', version: env.appVersion, env };

    let returned;
    try {
        returned = wrapper(
            nodeRequire,
            nodeRequire,
            module,
            module.exports,
            console,
            env,
            URL,
            pluginProcess,
            loadModule('buffer').Buffer,
        );
    } catch (error) {
        throw new CustomSourceLoadError(`script threw while loading: ${error && error.message ? error.message : String(error)}`);
    }

    // MusicFree accepts either `module.exports` or `module.exports.default`; the wrapper's own return
    // value is ignored, as it is there. A plugin that does `export default {...}` compiles to the
    // latter, so both shapes have to be read.
    const exported = module.exports;
    const instance = exported && exported.default ? exported.default : exported;

    if (!instance || typeof instance !== 'object') {
        throw new CustomSourceLoadError('script does not export a plugin object');
    }
    if (typeof instance.platform !== 'string' || instance.platform.trim().length === 0) {
        throw new CustomSourceLoadError('plugin has no platform name');
    }

    // A method list read once, as MusicFree does: `supportedMethods` decides which calls are worth
    // making, and a plugin that adds a method later is not supported by either host.
    const methods = Object.keys(instance).filter((key) => typeof instance[key] === 'function');

    return {
        platform: instance.platform.trim(),
        version: typeof instance.version === 'string' ? instance.version : null,
        author: typeof instance.author === 'string' ? instance.author : null,
        description: typeof instance.description === 'string' ? instance.description : null,
        homepage: typeof instance.homepage === 'string' ? instance.homepage : null,
        primaryKey: Array.isArray(instance.primaryKey) ? instance.primaryKey.filter((key) => typeof key === 'string') : null,
        userVariables: Array.isArray(instance.userVariables)
            ? instance.userVariables
                .filter((entry) => entry && typeof entry.key === 'string' && entry.key.length > 0)
                .map((entry) => ({
                    key: entry.key,
                    name: typeof entry.name === 'string' ? entry.name : null,
                }))
            : [],
        supportedMethods: methods,
        instance,
        returned,
    };
};

export { loadPlugin, CustomSourceLoadError };