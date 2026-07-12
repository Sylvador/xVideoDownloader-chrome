// Кнопка "Скачать видео" под каждым video-элементом на странице X/Twitter.
// Кнопка рисуется поверх страницы (position: fixed), а не вставляется в DOM самого твита —
// так React-рендеринг X не удалит и не сломает наш узел при перерисовке ленты.

(() => {
    const trackedVideos = new Map(); // video -> { wrapper, button, status }
    let activeButton = null;

    function createButtonFor(video) {
        if (trackedVideos.has(video)) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'hls-dl-button-wrapper';
        wrapper.style.cssText = `
            position: fixed;
            z-index: 2147483647;
            display: flex;
            align-items: center;
            gap: 6px;
            pointer-events: none;
        `;

        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '⬇ Скачать видео';
        button.style.cssText = `
            pointer-events: auto;
            font: 600 13px/1.2 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
            color: #fff;
            background: #1d9bf0;
            border: none;
            border-radius: 9999px;
            padding: 8px 14px;
            cursor: pointer;
            box-shadow: 0 1px 4px rgba(0,0,0,.35);
            white-space: nowrap;
        `;
        button.addEventListener('mouseenter', () => { button.style.background = '#1a8cd8'; });
        button.addEventListener('mouseleave', () => { button.style.background = '#1d9bf0'; });

        const status = document.createElement('span');
        status.style.cssText = `
            pointer-events: none;
            font: 500 12px/1.2 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
            color: #fff;
            background: rgba(0,0,0,.75);
            border-radius: 6px;
            padding: 4px 8px;
            display: none;
            white-space: nowrap;
        `;

        wrapper.appendChild(button);
        wrapper.appendChild(status);
        document.body.appendChild(wrapper);

        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            startDownload(button, status);
        });

        trackedVideos.set(video, { wrapper, button, status });
        repositionButton(video);
    }

    function repositionButton(video) {
        const entry = trackedVideos.get(video);
        if (!entry) return;

        if (!video.isConnected) {
            entry.wrapper.remove();
            if (activeButton === entry.button) activeButton = null;
            trackedVideos.delete(video);
            return;
        }

        const rect = video.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
        entry.wrapper.style.display = visible ? 'flex' : 'none';
        if (!visible) return;

        entry.wrapper.style.left = `${Math.round(rect.right - entry.wrapper.getBoundingClientRect().width)}px`;
        entry.wrapper.style.top = `${Math.round(rect.bottom + 6)}px`;
    }

    function repositionAll() {
        for (const video of trackedVideos.keys()) repositionButton(video);
    }

    let repositionScheduled = false;
    function scheduleReposition() {
        if (repositionScheduled) return;
        repositionScheduled = true;
        requestAnimationFrame(() => {
            repositionScheduled = false;
            repositionAll();
        });
    }

    window.addEventListener('scroll', scheduleReposition, { passive: true, capture: true });
    window.addEventListener('resize', scheduleReposition, { passive: true });

    function scanForVideos() {
        const video = document.querySelector('video')
        if (video) {
            createButtonFor(video)
        }
    }

    const observer = new MutationObserver(() => {
        scanForVideos();
        scheduleReposition();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    scanForVideos();
    scheduleReposition();
    // X — SPA с ленивой подгрузкой видео при скролле; периодическая подстраховка на случай,
    // если MutationObserver пропустит момент появления video-тега.
    setInterval(() => {
        scanForVideos();
        scheduleReposition();
    }, 2000);

    function startDownload(button, status) {
        if (activeButton) return; // не даём запустить второе скачивание, пока идёт первое
        activeButton = button;
        button.disabled = true;
        button.style.opacity = '0.6';
        status.style.display = 'inline-block';
        status.style.background = 'rgba(0,0,0,.75)';
        status.textContent = 'Ищу поток…';

        chrome.runtime.sendMessage({ type: 'START_DOWNLOAD' }, (response) => {
            if (chrome.runtime.lastError) {
                finish(button, status, `Ошибка: ${chrome.runtime.lastError.message}`, true);
                return;
            }
            if (!response?.ok) {
                finish(button, status, `Ошибка: ${response?.error || 'неизвестная ошибка'}`, true);
            }
            // Дальнейшие обновления статуса приходят через PROGRESS/DONE/ERROR
        });
    }

    function finish(button, status, text, isError) {
        status.textContent = text;
        status.style.background = isError ? 'rgba(220,40,40,.9)' : 'rgba(0,150,80,.9)';
        button.disabled = false;
        button.style.opacity = '1';
        if (activeButton === button) activeButton = null;
        setTimeout(() => {
            status.style.display = 'none';
        }, 4000);
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (!activeButton) return;
        const entry = [...trackedVideos.values()].find((e) => e.button === activeButton);
        if (!entry) return;

        if (message.type === 'PROGRESS') {
            entry.status.textContent = message.message + (message.percent != null ? ` (${message.percent}%)` : '');
        } else if (message.type === 'DONE') {
            finish(entry.button, entry.status, message.message || 'Готово!', false);
        } else if (message.type === 'ERROR') {
            finish(entry.button, entry.status, `Ошибка: ${message.message}`, true);
        }
    });
})();
