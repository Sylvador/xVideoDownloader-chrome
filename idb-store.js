// Маленькая обёртка над IndexedDB для передачи больших бинарных данных
// между service worker (background.js) и offscreen-документом (offscreen.js).
//
// Почему не через chrome.runtime.sendMessage: у него жёсткий лимит 64 МиБ на сообщение,
// а видео+аудио (и тем более итоговый смикшированный файл) легко его превышают.
// IndexedDB — общее хранилище для всех контекстов одного расширения (тот же origin
// chrome-extension://<id>), поэтому background и offscreen видят одни и те же записи.

const DB_NAME = 'hls-downloader';
const STORE_NAME = 'blobs';
const DB_VERSION = 1;

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(STORE_NAME);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        db.addEventListener('close', () => {}, { once: true });
    }).finally(() => db.close());
}

export async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    }).finally(() => db.close());
}

export async function idbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }).finally(() => db.close());
}
