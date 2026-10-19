
// electron/customSource/mediaHeaders.cjs
// Request headers for audio URLs a custom source handed out.
//
// A plugin's `getMediaSource` returns `{ url, headers }`, and those headers are not optional
// decoration: bilibili's audio CDN answers a request without its `Referer` with a few hundred bytes
// of error page under `video/mp4`, and several sources sign the request with the same `User-Agent`
// they searched with. An `<audio>` element cannot set a header, so the request is rewritten in the
// main process before it leaves.
//
// Scope is what keeps this from becoming a general-purpose header injector: a URL is only touched
// after a provider issued it, and only for as long as the issuer says (an audio URL expires). The
// table is bounded and drops its oldest entries, so a long session cannot grow it without limit.

// How long an issued URL keeps its headers. Audio URLs from these sources expire in minutes to a
// few hours; two hours covers the long tail without keeping dead entries around.
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
// Hard cap on remembered URLs. A queue of a few hundred songs is well inside it.
const MAX_ENTRIES = 4096;

// Headers a page must not be allowed to set through this path: they describe the request itself,
// not the media, and letting a script pick them would let it steer the connection.
const FORBIDDEN_HEADERS = new Set([
    'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
    'proxy-authorization', 'proxy-connection', 'cookie2', 'accept-encoding', 'range',
]);

const normalizeUrl = (value) => {
    try {
        const url = new URL(String(value));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        if (url.username || url.password) return null;
        url.hash = '';
        return url.href;
    } catch {
        return null;
    }
};

/** Drops the headers this path refuses to set, and keeps only string values. */
const sanitizeHeaders = (headers) => {
    const clean = {};
    if (!headers || typeof headers !== 'object') return clean;
    Object.entries(headers).forEach(([name, value]) => {
        if (typeof value !== 'string' || value.length === 0) return;
        const lower = name.toLowerCase();
        if (FORBIDDEN_HEADERS.has(lower)) return;
        clean[lower] = value;
    });
    return clean;
};

const createCustomSourceMediaHeaders = ({ now = Date.now } = {}) => {
    // url -> { headers, expiresAt }. A Map keeps insertion order, which is what eviction uses.
    const issued = new Map();

    /** Remembers the headers for one issued audio URL. Returns whether anything was registered. */
    const register = (url, headers, ttlMs = DEFAULT_TTL_MS) => {
        const key = normalizeUrl(url);
        if (!key) return false;
        const clean = sanitizeHeaders(headers);
        if (Object.keys(clean).length === 0) {
            issued.delete(key);
            return false;
        }
        // Re-inserting moves the entry to the end, so the eviction order stays least-recently-issued.
        issued.delete(key);
        issued.set(key, { headers: clean, expiresAt: now() + ttlMs });
        while (issued.size > MAX_ENTRIES) {
            const oldest = issued.keys().next().value;
            if (oldest === undefined) break;
            issued.delete(oldest);
        }
        return true;
    };

    /** The headers to set for this URL, or null. Expired entries are dropped as they are found. */
    const headersFor = (url) => {
        const key = normalizeUrl(url);
        if (!key) return null;
        const entry = issued.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= now()) {
            issued.delete(key);
            return null;
        }
        return entry.headers;
    };

    const forget = (url) => {
        const key = normalizeUrl(url);
        return key ? issued.delete(key) : false;
    };

    const clear = () => issued.clear();

    /*
     * The `onBeforeSendHeaders` listener. Only media, XHR and image requests are considered: a
     * navigation or a fetch of a page has no business carrying these headers, and matching them
     * would let a redirect walk the headers onto a different resource.
     */
    const onBeforeSendHeaders = (details, callback) => {
        const resourceType = details.resourceType;
        if (resourceType !== 'media' && resourceType !== 'xhr' && resourceType !== 'image') {
            callback({});
            return;
        }
        const headers = headersFor(details.url);
        if (!headers) {
            callback({});
            return;
        }
        const requestHeaders = { ...details.requestHeaders };
        Object.entries(headers).forEach(([name, value]) => {
            // Header names are case-insensitive and Chromium sends its own spelling; drop any
            // existing entry that differs only in case before adding ours.
            Object.keys(requestHeaders).forEach((existing) => {
                if (existing.toLowerCase() === name) delete requestHeaders[existing];
            });
            requestHeaders[name] = value;
        });
        callback({ requestHeaders });
    };

    return {
        register,
        headersFor,
        forget,
        clear,
        onBeforeSendHeaders,
        /** Entry count, for the settings page's diagnostics. */
        size: () => issued.size,
    };
};

export { createCustomSourceMediaHeaders, sanitizeHeaders, DEFAULT_TTL_MS };