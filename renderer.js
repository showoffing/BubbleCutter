// ------------------------------------------------------------------
//  Bubble Cutter Pro — renderer
//  Сайдбар всегда видим; справа над холстом — три вкладки с кнопками.
// ------------------------------------------------------------------

const PHOTOCRAFT_FALLBACK = { width: 1920, height: 1080 };

// ---------------------------  i18n  ----------------------------------
let lang = 'ru';
let DICTS = {};

function t(key, placeholders = {}) {
    const parts = key.split('.');
    let node = DICTS[lang] || {};
    for (const p of parts) {
        if (node == null) break;
        node = node[p];
    }
    if (typeof node !== 'string') return key;

    let text = node;
    for (const [ph, val] of Object.entries(placeholders)) {
        text = text.split('{' + ph + '}').join(String(val));
    }
    return text;
}

// ---------------------------  СОСТОЯНИЕ  ------------------------------
const state = {
    files: [],
    currentFileIdx: -1,
    points: [],
    tolerance: 20,
    zoom: 1.0,
    panX: 0,
    panY: 0,
    isPanning: false,
    panStartX: 0,
    panStartY: 0,
    centered: false,
    previewZoom: 1.0,
    previewPanX: 0,
    previewPanY: 0,
    previewIsPanning: false,
    previewPanStartX: 0,
    previewPanStartY: 0,
    currentMaskBase64: null,
    currentSubpaths: null,
    previewSvgPath: null,
    saveAfter: 'next', // 'next' | 'current'
    tab: 'contours',
};

// ---------------------------  DOM  -----------------------------------
const $ = (id) => document.getElementById(id);

const imgElement = $('main-image');
const canvasEl = $('overlay');
const ctx = canvasEl.getContext('2d');
const container = document.querySelector('.canvas-container');
const pContainer = document.querySelector('.preview-container');
const placeholder = $('placeholder');
const previewModal = $('preview-modal');
const previewImg = $('preview-img');
const fileList = $('file-list');
const toolbar = $('toolbar');
const tabBar = $('tab-bar');

function currentPath() {
    return state.files[state.currentFileIdx] || null;
}

// Любое изменение точек/толерантности делает старый предпросмотр невалидным
function invalidatePreview() {
    state.currentMaskBase64 = null;
    state.currentSubpaths = null;
    state.previewSvgPath = null;
}

// ---------------------------  ВКЛАДКИ  --------------------------------
const TAB_DEFS = {
    contours: [
        { key: 'preview',    cls: 'info',       label: () => t('buttons.contours.preview'),    run: doPreview },
        { key: 'save',       cls: 'success',    label: () => t('buttons.contours.save'),       run: doSave },
        { key: 'autodetect', cls: 'btn-purple', label: () => t('buttons.contours.autodetect'), run: doAutodetect },
    ],
    photocraft: [
        { key: 'launch',      cls: 'btn-purple', label: () => t('buttons.photocraft.launch'),      run: doLaunch },
        { key: 'send',        cls: 'btn-green',  label: () => t('buttons.photocraft.send'),        run: doSend },
        { key: 'choose_path', cls: 'info',       label: () => t('buttons.photocraft.choose_path'), run: doChoosePath },
        { key: 'open_folder', cls: 'info',       label: () => t('buttons.photocraft.open_folder'), run: () => openFolder() },
    ],
    diagnostics: [
        { key: 'test',     cls: 'btn-dark',    label: () => t('buttons.diagnostics.test'),     run: doTest },
        { key: 'diagnose', cls: 'btn-warning', label: () => t('buttons.diagnostics.diagnose'), run: doDiagnose },
    ],
};

function renderToolbar() {
    toolbar.innerHTML = '';
    TAB_DEFS[state.tab].forEach((def) => {
        const btn = document.createElement('button');
        btn.className = def.cls;
        btn.textContent = def.label();
        btn.onclick = () => def.run(btn);
        toolbar.appendChild(btn);
    });
}

function switchTab(key) {
    if (!TAB_DEFS[key]) return;
    state.tab = key;
    Array.from(tabBar.children).forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    renderToolbar();
}

tabBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-item');
    if (btn) switchTab(btn.dataset.tab);
});

// ---------------------------  BUSY-ХЕЛПЕР  ----------------------------
async function withBusy(btn, busyKey, fn) {
    const original = btn.textContent;
    btn.textContent = t(busyKey);
    btn.disabled = true;
    try {
        return await fn();
    } finally {
        btn.textContent = original;
        btn.disabled = false;
    }
}

// ---------------------------  ЯЗЫК  -----------------------------------
function setLanguage(newLang) {
    if (newLang !== 'ru' && newLang !== 'en') return;
    lang = newLang;
    try { localStorage.setItem('lang', lang); } catch (e) { /* ignore */ }
    applyLanguage();
    try { window.api.setMenuLanguage(lang); } catch (e) { /* ignore */ }
}

function applyLanguage() {
    $('lang-title').textContent = t('common.language');
    $('lang-ru').classList.toggle('active', lang === 'ru');
    $('lang-en').classList.toggle('active', lang === 'en');

    $('btn-load').innerHTML = t('common.load_files');
    $('btn-folder-load').innerHTML = t('common.load_folder');
    $('btn-clear').innerHTML = t('common.clear_points');

    $('tol-label').textContent = t('common.tolerance');
    $('save-mode-title').textContent = t('settings.behavior_after_save');
    $('save-next-label').textContent = t('settings.next_image');
    $('save-current-label').textContent = t('settings.stay_on_current');

    $('placeholder-text').textContent = t('placeholder.empty');
    $('modal-title').textContent = t('modal.title');
    $('btn-close-preview').textContent = t('common.close_preview');

    Array.from(tabBar.children).forEach((b) => { b.textContent = t('tabs.' + b.dataset.tab); });

    updateContextMenuLabels();
    renderToolbar();
    updateFileList();
}

// ---------------------------  ФАЙЛЫ  ----------------------------------
async function loadFiles() {
    const files = await window.api.selectFiles();
    if (!files || files.length === 0) return;
    state.files = files;
    updateFileList();
    loadFile(0);
}

async function loadFolder() {
    const result = await window.api.selectFolder();
    if (!result || result.canceled) return;

    const loaded = await window.api.loadFolderImages(result.folderPath);
    if (loaded.error) {
        alert(t('alerts.load_folder_error', { error: loaded.error }));
        return;
    }
    if (!loaded.files || loaded.files.length === 0) {
        alert(t('alerts.folder_no_images'));
        return;
    }

    const existing = new Set(state.files);
    let added = 0;
    loaded.files.forEach((f) => {
        if (!existing.has(f)) { state.files.push(f); existing.add(f); added++; }
    });

    updateFileList();
    if (state.currentFileIdx === -1 && state.files.length > 0) loadFile(0);
}

function fileBaseName(filePath) {
    return filePath.split('\\').pop().split('/').pop();
}

function fileExtension(filePath) {
    const name = fileBaseName(filePath);
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

// Миниатюра 40x40: картинки — через <img> (pathToFileURL), SVG — квадратик с текстом.
function createThumb(filePath) {
    const thumb = document.createElement('span');
    thumb.className = 'thumb';

    const ext = fileExtension(filePath);
    if (ext === 'svg') {
        thumb.classList.add('svg-box');
        thumb.textContent = 'SVG';
        return thumb;
    }

    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => { thumb.classList.add('svg-box'); thumb.textContent = '?'; };
    img.src = window.api.pathToFileURL(filePath);
    thumb.appendChild(img);
    return thumb;
}

function updateFileList() {
    fileList.innerHTML = '';
    if (state.files.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = t('placeholder.file_list');
        fileList.appendChild(li);
        return;
    }
    state.files.forEach((f, i) => {
        const li = document.createElement('li');
        li.appendChild(createThumb(f));

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = fileBaseName(f);
        li.appendChild(name);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'file-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.title = t('filelist.close');
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeFile(i);
        });
        li.appendChild(closeBtn);

        li.onclick = () => loadFile(i);
        if (i === state.currentFileIdx) li.classList.add('active');
        fileList.appendChild(li);
    });
}

// Сброс холста и изображения, когда список файлов пуст
function resetCanvasToPlaceholder() {
    state.points = [];
    state.zoom = 1.0;
    state.panX = 0;
    state.panY = 0;
    state.centered = false;
    invalidatePreview();
    imgElement.style.display = 'none';
    imgElement.removeAttribute('src');
    canvasEl.width = 0;
    canvasEl.height = 0;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (placeholder) placeholder.classList.remove('hidden');
    if (!previewModal.classList.contains('hidden')) closePreview();
}

// Удаление одного файла; корректно правит currentFileIdx
function removeFile(idx) {
    if (idx < 0 || idx >= state.files.length) return;
    const wasActive = idx === state.currentFileIdx;
    state.files.splice(idx, 1);

    if (state.files.length === 0) {
        state.currentFileIdx = -1;
        resetCanvasToPlaceholder();
        updateFileList();
        return;
    }

    if (wasActive) {
        // следующий файл теперь на том же индексе; если удалили последний — берём предыдущий
        let nextIdx = idx;
        if (nextIdx >= state.files.length) nextIdx = state.files.length - 1;
        loadFile(nextIdx);
    } else {
        // удалили элемент раньше текущего — сдвигаем индекс
        if (idx < state.currentFileIdx) state.currentFileIdx -= 1;
        updateFileList();
    }
}

function clearFileList() {
    state.files = [];
    state.currentFileIdx = -1;
    resetCanvasToPlaceholder();
    updateFileList();
}

function closeAllExceptCurrent() {
    const active = state.currentFileIdx;
    if (active === -1 || state.files.length === 0) return;
    const keep = state.files[active];
    state.files = [keep];
    state.currentFileIdx = 0;
    updateFileList();
}

// ---------------------------  КОНТЕКСТНОЕ МЕНЮ  ------------------------
let ctxMenu = null;
let ctxMenuClearItem = null;
let ctxMenuCloseOthersItem = null;

function buildContextMenu() {
    ctxMenu = document.createElement('div');
    ctxMenu.id = 'file-context-menu';
    ctxMenu.className = 'context-menu hidden';
    document.body.appendChild(ctxMenu);

    ctxMenuClearItem = document.createElement('button');
    ctxMenuClearItem.className = 'context-menu-item';
    ctxMenuClearItem.addEventListener('click', () => { hideContextMenu(); clearFileList(); });
    ctxMenu.appendChild(ctxMenuClearItem);

    ctxMenuCloseOthersItem = document.createElement('button');
    ctxMenuCloseOthersItem.className = 'context-menu-item';
    ctxMenuCloseOthersItem.addEventListener('click', () => { hideContextMenu(); closeAllExceptCurrent(); });
    ctxMenu.appendChild(ctxMenuCloseOthersItem);

    updateContextMenuLabels();
}

function updateContextMenuLabels() {
    if (!ctxMenu) return;
    ctxMenuClearItem.textContent = t('filelist.clear_list');
    ctxMenuCloseOthersItem.textContent = t('filelist.close_others');
}

function showContextMenu(x, y) {
    if (!ctxMenu) return;
    ctxMenu.classList.remove('hidden');
    const mw = ctxMenu.offsetWidth || 200;
    const mh = ctxMenu.offsetHeight || 100;
    const maxX = window.innerWidth - mw - 4;
    const maxY = window.innerHeight - mh - 4;
    ctxMenu.style.left = Math.max(4, Math.min(x, maxX)) + 'px';
    ctxMenu.style.top = Math.max(4, Math.min(y, maxY)) + 'px';
}

function hideContextMenu() {
    if (ctxMenu) ctxMenu.classList.add('hidden');
}

function wireContextMenu() {
    fileList.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY);
    });
    document.addEventListener('contextmenu', () => hideContextMenu());
    document.addEventListener('click', () => hideContextMenu());
    window.addEventListener('blur', () => hideContextMenu());
}

function loadFile(idx) {
    state.currentFileIdx = idx;
    state.points = [];
    state.zoom = 1.0;
    state.panX = 0;
    state.panY = 0;
    state.centered = false;
    invalidatePreview();
    updateFileList();

    imgElement.style.display = 'block';
    const fileURL = window.api.pathToFileURL(state.files[idx]);

    const onLoaded = () => {
        if (placeholder) placeholder.classList.add('hidden');
        updateCanvasSize();
        applyTransform();
    };

    imgElement.onload = onLoaded;
    imgElement.onerror = () => {
        imgElement.style.display = 'none';
        if (placeholder) placeholder.classList.remove('hidden');
        alert(t('alerts.load_error', { path: state.files[idx] }));
    };

    // Если src не менялся, событие load может не сработать повторно
    if (imgElement.getAttribute('src') === fileURL && imgElement.complete && imgElement.naturalWidth > 0) {
        onLoaded();
    } else {
        imgElement.src = fileURL;
    }
}

function updateCanvasSize() {
    canvasEl.width = imgElement.naturalWidth;
    canvasEl.height = imgElement.naturalHeight;
}

function applyTransform() {
    const cw = container.clientWidth, ch = container.clientHeight;
    const iw = imgElement.naturalWidth, ih = imgElement.naturalHeight;
    if (!iw || !ih) return;

    if (!state.centered) {
        state.panX = (cw - iw * state.zoom) / 2;
        state.panY = (ch - ih * state.zoom) / 2;
        state.centered = true;
    }

    const transformStr = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    imgElement.style.transform = transformStr;
    canvasEl.style.transform = transformStr;
    drawPoints();
}

function drawPoints() {
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.fillStyle = 'red';
    const radius = 5 / state.zoom;
    state.points.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p[0], p[1], radius, 0, Math.PI * 2);
        ctx.fill();
    });
}

// ---------------------------  ЗУМ / ПАН / ТОЧКИ  ----------------------
function wireCanvasInteractions() {
    container.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const rect = container.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;
            const ix = (mx - state.panX) / state.zoom, iy = (my - state.panY) / state.zoom;
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            state.zoom = Math.max(0.1, Math.min(state.zoom * factor, 10));
            state.panX = mx - ix * state.zoom;
            state.panY = my - iy * state.zoom;
            applyTransform();
        }
    }, { passive: false });

    container.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
            e.preventDefault();
            state.isPanning = true;
            const rect = container.getBoundingClientRect();
            state.panStartX = (e.clientX - rect.left) - state.panX;
            state.panStartY = (e.clientY - rect.top) - state.panY;
            container.style.cursor = 'grabbing';
        }
    });

    container.addEventListener('mousemove', (e) => {
        if (state.isPanning) {
            const rect = container.getBoundingClientRect();
            state.panX = (e.clientX - rect.left) - state.panStartX;
            state.panY = (e.clientY - rect.top) - state.panStartY;
            applyTransform();
        }
    });

    container.addEventListener('mouseup', (e) => {
        if (e.button === 1) {
            state.isPanning = false;
            container.style.cursor = 'default';
        }
    });

    container.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

    canvasEl.addEventListener('mousedown', (e) => {
        if (state.currentFileIdx === -1) return;

        const rect = container.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const ox = (mx - state.panX) / state.zoom, oy = (my - state.panY) / state.zoom;

        if (e.button === 0) {
            if (ox >= 0 && ox < imgElement.naturalWidth && oy >= 0 && oy < imgElement.naturalHeight) {
                state.points.push([Math.floor(ox), Math.floor(oy)]);
                invalidatePreview();
                drawPoints();
            }
        } else if (e.button === 2) {
            if (state.points.length === 0) return;

            let closestIdx = -1;
            let minDist = 20 / state.zoom;
            state.points.forEach((p, idx) => {
                const d = Math.hypot(p[0] - ox, p[1] - oy);
                if (d < minDist) { minDist = d; closestIdx = idx; }
            });

            if (closestIdx !== -1) {
                state.points.splice(closestIdx, 1);
                invalidatePreview();
                drawPoints();
            }
        }
    });

    canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------------------------  ПРЕДПРОСМОТР  ---------------------------
function applyPreviewTransform() {
    previewImg.style.transform =
        `translate(${state.previewPanX}px, ${state.previewPanY}px) scale(${state.previewZoom})`;
}

function wirePreviewInteractions() {
    pContainer.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const rect = pContainer.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;
            const ix = (mx - state.previewPanX) / state.previewZoom, iy = (my - state.previewPanY) / state.previewZoom;
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            state.previewZoom = Math.max(0.1, Math.min(state.previewZoom * factor, 10));
            state.previewPanX = mx - ix * state.previewZoom;
            state.previewPanY = my - iy * state.previewZoom;
            applyPreviewTransform();
        }
    }, { passive: false });

    pContainer.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
            e.preventDefault();
            state.previewIsPanning = true;
            const rect = pContainer.getBoundingClientRect();
            state.previewPanStartX = (e.clientX - rect.left) - state.previewPanX;
            state.previewPanStartY = (e.clientY - rect.top) - state.previewPanY;
            pContainer.style.cursor = 'grabbing';
        }
    });

    pContainer.addEventListener('mousemove', (e) => {
        if (state.previewIsPanning) {
            const rect = pContainer.getBoundingClientRect();
            state.previewPanX = (e.clientX - rect.left) - state.previewPanStartX;
            state.previewPanY = (e.clientY - rect.top) - state.previewPanStartY;
            applyPreviewTransform();
        }
    });

    pContainer.addEventListener('mouseup', (e) => {
        if (e.button === 1) {
            state.previewIsPanning = false;
            pContainer.style.cursor = 'default';
        }
    });

    pContainer.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
}

function closePreview() {
    previewModal.classList.add('hidden');
}

// ---------------------------  ДЕЙСТВИЯ  -------------------------------
async function doPreview(btn) {
    const imagePath = currentPath();
    if (!imagePath) { alert(t('alerts.no_image')); return; }
    if (state.points.length === 0) { alert(t('alerts.no_points')); return; }

    await withBusy(btn, 'busy.processing', async () => {
        const result = await window.api.runPython({
            action: 'process',
            image_path: imagePath,
            points: state.points,
            tolerance: state.tolerance,
            output_svg_path: 'bubblecutter_preview.svg',
        });

        if (result.error) {
            alert(t('alerts.preview_error', { error: result.error }));
            return;
        }

        state.currentMaskBase64 = result.mask_base64;
        state.currentSubpaths = result.subpaths || [];
        state.previewSvgPath = result.svg_path || null;

        previewImg.onload = () => {
            const cw = pContainer.clientWidth, ch = pContainer.clientHeight;
            const iw = previewImg.naturalWidth, ih = previewImg.naturalHeight;
            state.previewZoom = Math.min(cw / iw, ch / ih) * 0.9;
            state.previewPanX = (cw - iw * state.previewZoom) / 2;
            state.previewPanY = (ch - ih * state.previewZoom) / 2;
            applyPreviewTransform();
        };
        previewImg.src = 'data:image/png;base64,' + result.mask_base64;

        previewModal.classList.remove('hidden');
    });
}

async function doSave(btn) {
    const imagePath = currentPath();
    if (!imagePath) { alert(t('alerts.no_image')); return; }
    if (!state.previewSvgPath) { alert(t('alerts.nothing_to_save')); return; }

    const defaultName = imagePath
        .split('\\').pop().split('/').pop()
        .replace(/\.[^/.]+$/, '') + '.svg';

    const savePath = await window.api.saveFile(defaultName);
    if (!savePath) return;

    const copyResult = await window.api.copySvg(state.previewSvgPath, savePath);
    if (!copyResult || !copyResult.success) {
        alert(t('alerts.error_save', { error: (copyResult && copyResult.error) || '' }));
        return;
    }

    const sendNow = confirm(t('alerts.saved', { path: savePath }) + '\n\n' + t('alerts.send_after_save'));
    if (sendNow) await doSend(null);

    closePreview();

    // Режим после сохранения
    if (state.saveAfter === 'next' && state.currentFileIdx + 1 < state.files.length) {
        loadFile(state.currentFileIdx + 1);
    }
}

async function doAutodetect(btn) {
    const imagePath = currentPath();
    if (!imagePath) { alert(t('alerts.no_image')); return; }

    await withBusy(btn, 'busy.analyzing', async () => {
        const result = await window.api.runPython({ action: 'detect', image_path: imagePath });
        if (result.error) {
            alert(t('alerts.autodetect_error', { error: result.error }));
            return;
        }
        if (result.points && result.points.length > 0) {
            state.points = result.points;
            invalidatePreview();
            drawPoints();
        } else {
            alert(t('alerts.autodetect_no_bubbles'));
        }
    });
}

async function doLaunch(btn) {
    const run = async () => {
        let result = await window.api.launchPhotoCraft();
        if (result.success) { alert(result.message); return; }

        if (result.needsPath) {
            // Файл не найден по стандартному пути — показываем диалог выбора
            const chosen = await window.api.choosePhotoCraftPath();
            if (chosen && chosen.success) {
                result = await window.api.launchPhotoCraft();
                if (result.success) { alert(result.message); return; }
            } else {
                return; // выбор отменён
            }
        }
        alert(t('alerts.launch_error', { error: result.error || '' }));
    };

    if (btn) await withBusy(btn, 'busy.launching', run);
    else await run();
}

async function doSend(btn) {
    if (!state.currentSubpaths || state.currentSubpaths.length === 0) {
        alert(t('alerts.send_no_contours'));
        return;
    }

    const run = async () => {
        const imgW = imgElement.naturalWidth || PHOTOCRAFT_FALLBACK.width;
        const imgH = imgElement.naturalHeight || PHOTOCRAFT_FALLBACK.height;
        const result = await window.api.sendToPhotoCraft(state.currentSubpaths, imgW, imgH);
        if (result.success) alert(t('alerts.send_success'));
        else alert(t('alerts.send_error', { error: result.error || '' }));
    };

    if (btn) await withBusy(btn, 'busy.sending', run);
    else await run();
}

async function doChoosePath() {
    const result = await window.api.choosePhotoCraftPath();
    if (result.success) {
        alert(t('alerts.path_chosen', { path: result.path }));
    } else if (!result.canceled && result.error) {
        alert(result.error);
    }
}

async function doTest(btn) {
    await withBusy(btn, 'busy.processing', async () => {
        const result = await window.api.testPhotoCraft();
        if (result.success) alert(t('alerts.test_success', { data: JSON.stringify(result.data) }));
        else alert(t('alerts.test_error', { error: result.error || '' }));
    });
}

async function doDiagnose(btn) {
    await withBusy(btn, 'busy.diagnosing', async () => {
        const result = await window.api.diagnosePhotoCraft();
        if (!result.success) {
            alert(t('alerts.diagnose_error', { error: result.error || '' }));
            return;
        }

        const data = result.data || {};
        const payloads = [data.command_list, data.engine_commands]
            .map((r) => (r && r.result !== undefined ? r.result : null))
            .filter(Boolean);

        let list = null;
        for (const payload of payloads) {
            if (Array.isArray(payload)) { list = payload; break; }
            if (payload && Array.isArray(payload.commands)) { list = payload.commands; break; }
        }

        const shapeCmd = list ? list.find((c) => c && c.id === 'select.convertToShape') : null;
        if (shapeCmd) {
            alert(t('alerts.diagnose_status', {
                enabled: shapeCmd.enabled,
                reason: shapeCmd.disabledReason || t('common.none'),
            }));
        } else {
            alert(t('alerts.diagnose_missing_cmd'));
        }
    });
}

async function openFolder() {
    const result = await window.api.openFolder('bridge');
    if (!result.success) {
        alert(t('alerts.open_folder_error', { error: result.error || '' }));
    }
}

function clearPoints() {
    state.points = [];
    invalidatePreview();
    drawPoints();
}

// ---------------------------  ГОРЯЧИЕ КЛАВИШИ  ------------------------
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !previewModal.classList.contains('hidden')) {
        closePreview();
        return;
    }

    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z' || e.key === 'я' || e.key === 'Я')) {
        if (!previewModal.classList.contains('hidden')) return;
        if (state.points.length > 0) {
            state.points.pop();
            invalidatePreview();
            drawPoints();
            e.preventDefault();
        }
    }
});

// ---------------------------  RESIZE  ---------------------------------
let resizeRaf = null;
window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => applyTransform());
});

// ---------------------------  ИНИЦИАЛИЗАЦИЯ  --------------------------
async function init() {
    try {
        DICTS = await window.api.getLocales();
    } catch (e) {
        console.error('Не удалось загрузить локализацию:', e);
        DICTS = { ru: {}, en: {} };
    }

    try {
        const savedLang = localStorage.getItem('lang');
        if (savedLang === 'ru' || savedLang === 'en') lang = savedLang;
    } catch (e) { /* ignore */ }

    try {
        const savedMode = localStorage.getItem('saveAfter');
        if (savedMode === 'next' || savedMode === 'current') state.saveAfter = savedMode;
    } catch (e) { /* ignore */ }

    // Статические контролы
    $('btn-load').addEventListener('click', loadFiles);
    $('btn-folder-load').addEventListener('click', loadFolder);
    $('btn-clear').addEventListener('click', clearPoints);
    $('btn-close-preview').addEventListener('click', closePreview);

    $('tolerance').addEventListener('input', (e) => {
        state.tolerance = parseInt(e.target.value, 10);
        $('tol-val').textContent = state.tolerance;
        invalidatePreview();
    });

    document.querySelectorAll('input[name="save-mode"]').forEach((r) => {
        r.addEventListener('change', () => {
            if (r.checked) {
                state.saveAfter = r.value;
                try { localStorage.setItem('saveAfter', r.value); } catch (e) { /* ignore */ }
            }
        });
    });

    $('lang-ru').addEventListener('click', () => setLanguage('ru'));
    $('lang-en').addEventListener('click', () => setLanguage('en'));

    // Меню Electron переключает язык — слушаем и применяем
    window.api.onLanguageChanged((newLang) => setLanguage(newLang));

    // Синхронизируем выбранный radio с сохранённым режимом
    const checkedRadio = document.querySelector(`input[name="save-mode"][value="${state.saveAfter}"]`);
    if (checkedRadio) checkedRadio.checked = true;

    wireCanvasInteractions();
    wirePreviewInteractions();

    buildContextMenu();
    wireContextMenu();

    setLanguage(lang);
}

init();
