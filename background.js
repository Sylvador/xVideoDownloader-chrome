import { parseMasterPlaylist, parseMediaPlaylist } from './playlist-parser.js';
import { idbSet, idbGet, idbDelete } from './idb-store.js';

// tabId -> Set<string> ссылок на .m3u8, замеченных на странице этой вкладки
const m3u8UrlsByTab = new Map();

// Следим за всеми сетевыми запросами к twimg.com и запоминаем те, что похожи на HLS-плейлисты.
// Это "наблюдательный" (не блокирующий) листенер — он разрешён в Manifest V3.
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (!details.url.includes('.m3u8')) return;
        const set = m3u8UrlsByTab.get(details.tabId) || new Set();
        set.add(details.url);
        m3u8UrlsByTab.set(details.tabId, set);
    },
    { urls: ['*://*.twimg.com/*'] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
    m3u8UrlsByTab.delete(tabId);
});

// Периодически подчищаем совсем старые записи, чтобы не течь по памяти на долгих сессиях
chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading') {
        m3u8UrlsByTab.delete(tabId);
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'START_DOWNLOAD') return false;
    const tabId = sender.tab?.id;
    if (tabId == null) {
        sendResponse({ ok: false, error: 'Не удалось определить вкладку.' });
        return false;
    }

    handleDownload(tabId).catch((err) => {
        console.error('[HLS Downloader] Ошибка:', err);
        notifyTab(tabId, { type: 'ERROR', message: err?.message || String(err) });
    });

    // Отвечаем сразу, дальше общаемся с content.js через отдельные сообщения (прогресс/готово/ошибка)
    sendResponse({ ok: true });
    return false;
});

function notifyTab(tabId, message) {
    chrome.tabs.sendMessage(tabId, message).catch(() => {
        // Вкладка могла быть закрыта/перезагружена — молча игнорируем
    });
}

async function handleDownload(tabId) {
    const urls = Array.from(m3u8UrlsByTab.get(tabId) || []);
    if (urls.length === 0) {
        throw new Error('Не найдено ни одного .m3u8 запроса. Запустите видео на странице и попробуйте снова.');
    }

    notifyTab(tabId, { type: 'PROGRESS', stage: 'searching', message: 'Ищу мастер-плейлист…' });

    const master = await findMasterPlaylist(urls);
    if (!master) {
        throw new Error('Среди перехваченных запросов не нашёлся мастер-плейлист (#EXT-X-STREAM-INF).');
    }

    const { videoUrl, audioUrl } = parseMasterPlaylist(master.text, master.url);

    notifyTab(tabId, { type: 'PROGRESS', stage: 'video', message: 'Скачиваю видео…', percent: 0 });
    const videoPlaylistText = await fetchText(videoUrl);
    const { mapUrl: videoMapUrl, segmentUrls: videoSegments } = parseMediaPlaylist(videoPlaylistText, videoUrl);
    const videoBytes = await downloadAndConcat(videoMapUrl, videoSegments, (done, total) => {
        notifyTab(tabId, {
            type: 'PROGRESS',
            stage: 'video',
            message: `Скачиваю видео: ${done}/${total}`,
            percent: Math.round((done / total) * 100),
        });
    });

    if (!audioUrl) {
        // Отдельной аудио-дорожки нет — простая склейка init-сегмента с сегментами
        // сама по себе уже даёт валидный воспроизводимый MP4 (немой).
        await triggerDownload(videoBytes, 'video.mp4');
        notifyTab(tabId, { type: 'DONE', message: 'Готово (без звука — отдельная аудио-дорожка не найдена).' });
        return;
    }

    notifyTab(tabId, { type: 'PROGRESS', stage: 'audio', message: 'Скачиваю аудио…', percent: 0 });
    const audioPlaylistText = await fetchText(audioUrl);
    const { mapUrl: audioMapUrl, segmentUrls: audioSegments } = parseMediaPlaylist(audioPlaylistText, audioUrl);
    const audioBytes = await downloadAndConcat(audioMapUrl, audioSegments, (done, total) => {
        notifyTab(tabId, {
            type: 'PROGRESS',
            stage: 'audio',
            message: `Скачиваю аудио: ${done}/${total}`,
            percent: Math.round((done / total) * 100),
        });
    });

    notifyTab(tabId, { type: 'PROGRESS', stage: 'mux', message: 'Склеиваю видео и аудио (ffmpeg.wasm)…' });
    const muxed = await muxWithFfmpeg(videoBytes, audioBytes);

    await triggerDownload(muxed, 'video.mp4');
    notifyTab(tabId, { type: 'DONE', message: 'Готово!' });
}

/**
 * Перебирает список замеченных .m3u8 URL и находит тот, что является мастер-плейлистом
 * (содержит #EXT-X-STREAM-INF со ссылками на варианты видео/аудио).
 */
async function findMasterPlaylist(urls) {
    for (const url of urls) {
        try {
            const text = await fetchText(url);
            if (text.includes('#EXT-X-STREAM-INF')) {
                return { url, text };
            }
        } catch (e) {
            // Пропускаем неудачные запросы и пробуем следующий URL
        }
    }
    return null;
}

async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} при запросе ${url}`);
    return res.text();
}

async function fetchArrayBufferWithRetry(url, maxRetries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.arrayBuffer();
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error(`Не удалось скачать ${url}: ${lastErr?.message || lastErr}`);
}

/**
 * Скачивает init-сегмент и все медиа-сегменты по порядку и склеивает их в один Uint8Array.
 * Простая конкатенация валидна, т.к. это fragmented MP4 одного трека (ровно как в исходном Node-скрипте).
 */
async function downloadAndConcat(mapUrl, segmentUrls, onProgress) {
    const allUrls = [mapUrl, ...segmentUrls];
    const buffers = [];
    let total = 0;

    for (let i = 0; i < allUrls.length; i++) {
        const buf = await fetchArrayBufferWithRetry(allUrls[i]);
        buffers.push(new Uint8Array(buf));
        total += buf.byteLength;
        onProgress?.(i + 1, allUrls.length);
    }

    const result = new Uint8Array(total);
    let offset = 0;
    for (const b of buffers) {
        result.set(b, offset);
        offset += b.length;
    }
    return result;
}

let offscreenReadyPromise = null;

async function ensureOffscreenDocument() {
    if (offscreenReadyPromise) return offscreenReadyPromise;

    offscreenReadyPromise = (async () => {
        const hasDoc = await chrome.offscreen.hasDocument?.();
        if (hasDoc) return;
        try {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['WORKERS'],
                justification: 'Склейка видео и аудио потоков в один MP4 через ffmpeg.wasm (нужен Web Worker).',
            });
        } catch (err) {
            // Service worker мог перезапуститься, при этом offscreen-документ уже существует
            // (на старых версиях Chrome без chrome.offscreen.hasDocument()) — это не ошибка.
            if (!String(err?.message).includes('single offscreen document')) throw err;
        }
    })();

    return offscreenReadyPromise;
}

/**
 * Отправляет video/audio байты в offscreen-документ, где ffmpeg.wasm мультиплексирует их
 * в один MP4 без перекодирования (аналог `ffmpeg -c:v copy -c:a copy` из исходного Node-скрипта).
 *
 * Сами байты в сообщении НЕ передаются — у chrome.runtime.sendMessage жёсткий лимит 64 МиБ
 * на сообщение, а видео/аудио/итоговый файл легко его превышают. Вместо этого кладём данные
 * в IndexedDB (она общая для background и offscreen-документа) и пересылаем только ключ задания.
 */
async function muxWithFfmpeg(videoBytes, audioBytes) {
    await ensureOffscreenDocument();

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await idbSet(`video:${jobId}`, videoBytes);
    await idbSet(`audio:${jobId}`, audioBytes);

    try {
        const response = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'MUX',
            jobId,
        });

        if (!response?.ok) {
            throw new Error(response?.error || 'Неизвестная ошибка при склейке через ffmpeg.wasm');
        }

        const result = await idbGet(`result:${jobId}`);
        if (!result) {
            throw new Error('Offscreen-документ отчитался об успехе, но результат не найден в хранилище.');
        }

        return new Uint8Array(result);
    } finally {
        await Promise.all([
            idbDelete(`video:${jobId}`),
            idbDelete(`audio:${jobId}`),
            idbDelete(`result:${jobId}`),
        ]).catch(() => {});
    }
}

async function triggerDownload(bytes, filename) {
    // В service worker нет FileReader и ненадёжен URL.createObjectURL(Blob) для downloads API,
    // поэтому кодируем файл в base64 data URL вручную — это работает из любого контекста расширения.
    // Для очень больших видео (сотни МБ) это не самый экономный по памяти способ, но для
    // типичных клипов из постов X/Twitter он простой и надёжный.
    const dataUrl = `data:video/mp4;base64,${uint8ArrayToBase64(bytes)}`;

    await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: true,
    });
}

function uint8ArrayToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000; // кусками, чтобы не упереться в лимит аргументов String.fromCharCode
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}
