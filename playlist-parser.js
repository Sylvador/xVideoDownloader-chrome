// Общая логика разбора HLS-плейлистов (.m3u8).
// Используется в background.js (service worker), поэтому оформлена как ES-модуль.

/**
 * Извлекает базовый URL из полного URL плейлиста (для резолва относительных ссылок).
 * @param {string} url
 * @returns {string}
 */
export function getBaseUrl(url) {
    const parts = url.split('?')[0].split('/');
    parts.pop();
    return parts.join('/') + '/';
}

/**
 * Приводит относительную или абсолютную ссылку к абсолютному URL относительно базового.
 * @param {string} relativeOrAbsolute
 * @param {string} baseUrl
 */
export function resolveUrl(relativeOrAbsolute, baseUrl) {
    return new URL(relativeOrAbsolute.trim(), baseUrl).href;
}

/**
 * Разбирает мастер-плейлист (.m3u8 с #EXT-X-STREAM-INF) и находит:
 *  - ссылку на медиа-плейлист видео с максимальным разрешением
 *  - ссылку на аудио-дорожку (первую найденную в #EXT-X-MEDIA)
 * @param {string} content
 * @param {string} masterUrl
 * @returns {{videoUrl: string, audioUrl: string|null}}
 */
export function parseMasterPlaylist(content, masterUrl) {
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);

    const audioTracks = [];
    for (const line of lines) {
        if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO')) {
            const uriMatch = line.match(/URI="([^"]+)"/);
            if (uriMatch) {
                audioTracks.push(resolveUrl(uriMatch[1], masterUrl));
            }
        }
    }

    const videoVariants = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
            const bwMatch = line.match(/BANDWIDTH=(\d+)/);
            const nextLine = lines[i + 1];
            if (nextLine && !nextLine.startsWith('#')) {
                videoVariants.push({
                    url: resolveUrl(nextLine, masterUrl),
                    width: resMatch ? parseInt(resMatch[1], 10) : 0,
                    height: resMatch ? parseInt(resMatch[2], 10) : 0,
                    bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
                });
            }
        }
    }

    if (videoVariants.length === 0) {
        throw new Error('В мастер-плейлисте не найдено ни одного видео-варианта (#EXT-X-STREAM-INF).');
    }

    videoVariants.sort((a, b) => (b.width * b.height - a.width * a.height) || (b.bandwidth - a.bandwidth));

    return {
        videoUrl: videoVariants[0].url,
        audioUrl: audioTracks[0] || null,
    };
}

/**
 * Разбирает медиа-плейлист (видео ИЛИ аудио) и возвращает ссылку на init-сегмент (MAP)
 * и список ссылок на сегменты, в порядке воспроизведения.
 * @param {string} content
 * @param {string} mediaUrl
 * @returns {{mapUrl: string, segmentUrls: string[]}}
 */
export function parseMediaPlaylist(content, mediaUrl) {
    const baseUrl = getBaseUrl(mediaUrl);

    const mapMatch = content.match(/#EXT-X-MAP:URI="([^"]+)"/);
    const segmentLines = content.match(/^(?!#).*\.(?:mp4|m4s)$/gm) || [];

    if (!mapMatch) {
        throw new Error(`Не найден MAP-файл в плейлисте: ${mediaUrl}`);
    }

    return {
        mapUrl: resolveUrl(mapMatch[1], baseUrl),
        segmentUrls: segmentLines.map((p) => resolveUrl(p, baseUrl)),
    };
}
