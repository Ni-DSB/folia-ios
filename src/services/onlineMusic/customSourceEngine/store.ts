// src/services/onlineMusic/customSourceEngine/store.ts
// 浏览器里的插件源存储：替代 electron/customSource/store.cjs。
//
// 桌面版把脚本存成一个 JSON 文件（deflate + base64）。WebView 里没有文件系统，改用 IndexedDB：
// 容量比 localStorage 大得多（插件是几十 KB 的源码），而且异步、不阻塞界面。
//
// 接口与桌面版完全一致（list / get / upsert / remove / setEnabled / setUserVariables），
// 这样 registry 那层不用区分宿主。区别只有一处：脚本不再压缩——浏览器里没有 zlib，
// 而 IndexedDB 存明文没有体积问题，省掉一次编解码也少一类失败。

const DB_NAME = 'folia-custom-sources';
const DB_VERSION = 1;
const STORE_NAME = 'sources';

/** 一条存下来的插件源：脚本是明文。 */
export interface StoredCustomSource {
    id: string;
    platform: string;
    version: string | null;
    author: string | null;
    description: string | null;
    homepage: string | null;
    enabled: boolean;
    userVariableValues: Record<string, unknown>;
    addedAt: number;
    updatedAt: number;
    script: string;
}

/** 与桌面版同形：短、路径安全、安装期内稳定。 */
export const createSourceId = () => `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const openDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
});

const withStore = async <T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
    const db = await openDatabase();
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, mode);
            const request = operation(tx.objectStore(STORE_NAME));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
            tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
        });
    } finally {
        db.close();
    }
};

const normalizeRow = (entry: any): StoredCustomSource | null => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.script !== 'string') return null;
    return {
        id: entry.id,
        platform: typeof entry.platform === 'string' ? entry.platform : '',
        version: typeof entry.version === 'string' ? entry.version : null,
        author: typeof entry.author === 'string' ? entry.author : null,
        description: typeof entry.description === 'string' ? entry.description : null,
        homepage: typeof entry.homepage === 'string' ? entry.homepage : null,
        enabled: entry.enabled !== false,
        userVariableValues: entry.userVariableValues && typeof entry.userVariableValues === 'object'
            ? entry.userVariableValues
            : {},
        addedAt: Number(entry.addedAt) || 0,
        updatedAt: Number(entry.updatedAt) || 0,
        script: entry.script,
    };
};

/**
 * 写操作串行化：一次导入与一次开关切换并发时，后写会覆盖先写。与桌面版同样用一条队列。
 */
export const createCustomSourceStore = () => {
    let queue: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
        const run = queue.then(task, task);
        queue = run.catch(() => undefined);
        return run;
    };

    /** 全部源，最新的在前。 */
    const list = async (): Promise<StoredCustomSource[]> => {
        const rows = await withStore<StoredCustomSource[]>('readonly', store => store.getAll() as IDBRequest<StoredCustomSource[]>);
        return (rows || [])
            .map(normalizeRow)
            .filter((row): row is StoredCustomSource => Boolean(row))
            .sort((left, right) => right.addedAt - left.addedAt);
    };

    /** 一个 id 的行，没有则 null。 */
    const get = async (id: string): Promise<StoredCustomSource | null> => {
        const rows = await list();
        return rows.find(row => row.id === id) ?? null;
    };

    /** 覆盖或追加一个源。`script` 是明文。 */
    const upsert = (entry: Partial<StoredCustomSource> & { id: string; script: string }) => enqueue(async () => {
        if (!entry || typeof entry.id !== 'string' || typeof entry.script !== 'string') {
            throw new Error('invalid-source-entry');
        }
        const existing = await get(entry.id);
        const now = Date.now();
        const stored: StoredCustomSource = {
            id: entry.id,
            platform: String(entry.platform ?? ''),
            version: entry.version ?? null,
            author: entry.author ?? null,
            description: entry.description ?? null,
            homepage: entry.homepage ?? null,
            enabled: entry.enabled !== false,
            userVariableValues: entry.userVariableValues && typeof entry.userVariableValues === 'object'
                ? entry.userVariableValues
                : {},
            addedAt: existing ? existing.addedAt : (Number(entry.addedAt) || now),
            updatedAt: now,
            script: entry.script,
        };
        await withStore('readwrite', store => store.put(stored) as unknown as IDBRequest<IDBValidKey>);
        return stored.id;
    });

    const remove = (id: string) => enqueue(async () => {
        const existing = await get(id);
        if (!existing) return false;
        await withStore('readwrite', store => store.delete(id) as unknown as IDBRequest<undefined>);
        return true;
    });

    /** 设一个源的启用开关；返回新值，没有这个源时返回 null。 */
    const setEnabled = (id: string, enabled: boolean) => enqueue(async () => {
        const target = await get(id);
        if (!target) return null;
        const next = { ...target, enabled: enabled !== false, updatedAt: Date.now() };
        await withStore('readwrite', store => store.put(next) as unknown as IDBRequest<IDBValidKey>);
        return next.enabled;
    });

    /** 保存听众为某个源填的变量值。 */
    const setUserVariables = (id: string, values: Record<string, unknown> | null | undefined) => enqueue(async () => {
        const target = await get(id);
        if (!target) return null;
        const next = {
            ...target,
            userVariableValues: values && typeof values === 'object' ? values : {},
            updatedAt: Date.now(),
        };
        await withStore('readwrite', store => store.put(next) as unknown as IDBRequest<IDBValidKey>);
        return next.userVariableValues;
    });

    return { list, get, upsert, remove, setEnabled, setUserVariables, createSourceId };
};
