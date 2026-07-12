import { FFmpeg } from './lib/ffmpeg/index.js';
import { idbGet, idbSet } from './idb-store.js';

let ffmpegPromise = null;

/**
 * Лениво создаёт и загружает ffmpeg.wasm (один раз на весь offscreen-документ).
 * Все URL — локальные ресурсы расширения, ничего не грузится из сети (требование MV3).
 */
function getFfmpeg() {
    if (!ffmpegPromise) {
        ffmpegPromise = (async () => {
            const instance = new FFmpeg();

            instance.on('log', ({ message }) => {
                console.debug('[ffmpeg]', message);
            });

            await instance.load({
                coreURL: chrome.runtime.getURL('lib/core/ffmpeg-core.js'),
                wasmURL: chrome.runtime.getURL('lib/core/ffmpeg-core.wasm'),
                classWorkerURL: chrome.runtime.getURL('lib/ffmpeg/worker.js'),
            });

            return instance;
        })();
    }
    return ffmpegPromise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== 'offscreen' || message?.type !== 'MUX') return false;

    (async () => {
        const { jobId } = message;
        try {
            const [videoBytes, audioBytes] = await Promise.all([
                idbGet(`video:${jobId}`),
                idbGet(`audio:${jobId}`),
            ]);
            if (!videoBytes || !audioBytes) {
                throw new Error('Не нашёл видео/аудио в хранилище по jobId — возможно, задание устарело.');
            }

            const ffmpeg = await getFfmpeg();

            await ffmpeg.writeFile('video_in.mp4', new Uint8Array(videoBytes));
            await ffmpeg.writeFile('audio_in.mp4', new Uint8Array(audioBytes));

            // -c:v copy -c:a copy: без перекодирования — просто объединяем два потока в один контейнер.
            // Это ровно то же самое, что делает `combineStreamsWithFfmpeg` в исходном Node-скрипте.
            await ffmpeg.exec([
                '-i', 'video_in.mp4',
                '-i', 'audio_in.mp4',
                '-c:v', 'copy',
                '-c:a', 'copy',
                'output.mp4',
            ]);

            const data = await ffmpeg.readFile('output.mp4'); // Uint8Array

            await ffmpeg.deleteFile('video_in.mp4').catch(() => {});
            await ffmpeg.deleteFile('audio_in.mp4').catch(() => {});
            await ffmpeg.deleteFile('output.mp4').catch(() => {});

            // Результат тоже не кладём в сообщение — тот же лимит 64 МиБ. Пишем в IndexedDB,
            // background.js заберёт его сам по jobId.
            await idbSet(`result:${jobId}`, data);

            sendResponse({ ok: true });
        } catch (err) {
            sendResponse({ ok: false, error: err?.message || String(err) });
        }
    })();

    return true; // держим канал открытым для асинхронного sendResponse
});
