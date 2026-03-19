
export interface StorageAdapter {
    setup(): Promise<void>;
    set(key: string, value: any): Promise<void>;
    get(key: string): Promise<any | null>;
    getAll(): Promise<any[]>;
}

const isBrowser = typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
const isNodeRuntime =
    typeof process !== 'undefined' &&
    typeof process.versions !== 'undefined' &&
    !!process.versions.node;
const isBunRuntime =
    typeof process !== 'undefined' &&
    typeof process.versions !== 'undefined' &&
    !!(process.versions as any).bun;
const isDenoRuntime = typeof (globalThis as any).Deno !== 'undefined';

export class UniversalStorage {
    private adapter!: StorageAdapter;

    constructor(
        private dbName: string = 'PrivacyCash',
        private storeName: string = 'evm'
    ) { }

    async init(): Promise<UniversalStorage> {
        if (isBrowser) {
            this.adapter = new BrowserIDBAdapter(this.dbName, this.storeName);
            await this.adapter.setup();
        } else {
            this.adapter = await this.createServerAdapter();
        }
        return this;
    }

    private async createServerAdapter(): Promise<StorageAdapter> {
        // Prefer sqlite on Node.js when available because it is durable and scalable.
        if (isNodeRuntime) {
            const sqliteAdapter = new NodeSQLiteAdapter(this.dbName);
            try {
                await sqliteAdapter.setup();
                return sqliteAdapter;
            } catch (error: any) {
                if (!isSqliteUnavailableError(error)) {
                    throw error;
                }
            }
        }

        // Bun/Deno/other runtimes can still persist using a JSON file.
        const fileAdapter = new ServerFileAdapter(this.dbName, this.storeName);
        try {
            await fileAdapter.setup();
            return fileAdapter;
        } catch {
            // Last resort for restricted server runtimes (e.g. no filesystem access).
            const memoryAdapter = new ServerMemoryAdapter();
            await memoryAdapter.setup();
            return memoryAdapter;
        }
    }

    async set(key: string, value: any): Promise<void> {
        return await this.adapter.set(key, value);
    }

    async get<T = any>(key: string): Promise<T | null> {
        return await this.adapter.get(key);
    }

    async getAll<T = any>(): Promise<T[]> {
        return await this.adapter.getAll();
    }
}

class BrowserIDBAdapter implements StorageAdapter {
    private db: IDBDatabase | null = null;

    constructor(private dbName: string, private storeName: string) { }

    setup(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = (e: any) => {
                const db = e.target.result as IDBDatabase;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
            request.onsuccess = (e: any) => {
                this.db = e.target.result;
                resolve();
            };
            request.onerror = () => reject(new Error("IndexedDB initialization failed"));
        });
    }

    async set(key: string, value: any): Promise<void> {
        if (!this.db) throw new Error("Database not initialized");
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        return new Promise((res, rej) => {
            const req = store.put(value, key);
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    }

    async get(key: string): Promise<any | null> {
        if (!this.db) throw new Error("Database not initialized");
        const tx = this.db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        return new Promise((res) => {
            const req = store.get(key);
            req.onsuccess = () => res(req.result || null);
        });
    }

    async getAll(): Promise<any[]> {
        if (!this.db) throw new Error("Database not initialized");
        const tx = this.db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        return new Promise((res) => {
            const req = store.getAll();
            req.onsuccess = () => res(req.result || []);
        });
    }
}

class NodeSQLiteAdapter implements StorageAdapter {
    private db: any;
    private fileName: string;

    constructor(dbName: string) {
        this.fileName = `./cache/${dbName}.db`;
    }

    async setup(): Promise<void> {
        const sqlite3 = loadNodeSqlite();
        const { Database } = sqlite3;
        this.db = new Database(this.fileName);
        await this.run('CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY, value TEXT)');
    }

    private run(sql: string, ...params: any[]): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, (err: any) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    private queryGet(sql: string, ...params: any[]): Promise<any> {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err: any, row: any) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    private queryAll(sql: string, ...params: any[]): Promise<any[]> {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err: any, rows: any[]) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async set(key: string, value: any): Promise<void> {
        await this.run('INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?)', key, JSON.stringify(value));
    }

    async get(key: string): Promise<any | null> {
        const row = await this.queryGet('SELECT value FROM storage WHERE key = ?', key);
        return row ? JSON.parse(row.value) : null;
    }

    async getAll(): Promise<any[]> {
        const rows = await this.queryAll('SELECT value FROM storage');
        return rows.map((row: any) => JSON.parse(row.value));
    }
}

function loadNodeSqlite(): any {
    // Use indirect eval so bundlers don't try to include sqlite3 in browser builds.
    const nodeRequire = (0, eval)('typeof require !== "undefined" ? require : undefined');
    if (!nodeRequire) {
        const error = new Error('sqlite3 is only available when Node.js require is present');
        (error as any).code = 'SQLITE_UNAVAILABLE';
        throw error;
    }
    try {
        return nodeRequire('sqlite3');
    } catch (error: any) {
        if (error && /Cannot find module 'sqlite3'|Cannot find module \"sqlite3\"/i.test(String(error.message))) {
            error.code = 'SQLITE_UNAVAILABLE';
        }
        throw error;
    }
}

function isSqliteUnavailableError(error: any): boolean {
    return error?.code === 'SQLITE_UNAVAILABLE';
}

class ServerFileAdapter implements StorageAdapter {
    private readonly fileName: string;
    private data: Record<string, any> = {};

    constructor(dbName: string, storeName: string) {
        this.fileName = `./cache/${dbName}.${storeName}.json`;
    }

    async setup(): Promise<void> {
        await ensureCacheDir();
        const raw = await readFileSafe(this.fileName);
        this.data = raw ? JSON.parse(raw) : {};
    }

    async set(key: string, value: any): Promise<void> {
        this.data[key] = value;
        await writeFileSafe(this.fileName, JSON.stringify(this.data));
    }

    async get(key: string): Promise<any | null> {
        return key in this.data ? this.data[key] : null;
    }

    async getAll(): Promise<any[]> {
        return Object.values(this.data);
    }
}

class ServerMemoryAdapter implements StorageAdapter {
    private data = new Map<string, any>();

    async setup(): Promise<void> {
        return;
    }

    async set(key: string, value: any): Promise<void> {
        this.data.set(key, value);
    }

    async get(key: string): Promise<any | null> {
        return this.data.has(key) ? this.data.get(key) : null;
    }

    async getAll(): Promise<any[]> {
        return Array.from(this.data.values());
    }
}

async function ensureCacheDir(): Promise<void> {
    if (isDenoRuntime) {
        await (globalThis as any).Deno.mkdir('./cache', { recursive: true });
        return;
    }

    if (isNodeRuntime || isBunRuntime) {
        const fs = await import('node:fs/promises');
        await fs.mkdir('./cache', { recursive: true });
        return;
    }

    throw new Error('Filesystem storage is not available in this runtime');
}

async function readFileSafe(path: string): Promise<string | null> {
    try {
        if (isDenoRuntime) {
            return await (globalThis as any).Deno.readTextFile(path);
        }

        if (isNodeRuntime || isBunRuntime) {
            const fs = await import('node:fs/promises');
            return await fs.readFile(path, 'utf8');
        }
    } catch (error: any) {
        if (isMissingFileError(error)) {
            return null;
        }
        throw error;
    }

    throw new Error('Filesystem storage is not available in this runtime');
}

async function writeFileSafe(path: string, content: string): Promise<void> {
    if (isDenoRuntime) {
        await (globalThis as any).Deno.writeTextFile(path, content);
        return;
    }

    if (isNodeRuntime || isBunRuntime) {
        const fs = await import('node:fs/promises');
        await fs.writeFile(path, content, 'utf8');
        return;
    }

    throw new Error('Filesystem storage is not available in this runtime');
}

function isMissingFileError(error: any): boolean {
    return error?.code === 'ENOENT' || error?.name === 'NotFound';
}