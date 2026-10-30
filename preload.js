// ----------  БЕЗОПАСНЫЙ МОСТ (contextIsolation: true)  ----------
const { contextBridge, ipcRenderer } = require('electron');

// В sandboxed-preload модуль url не содержит pathToFileURL,
// поэтому строим корректный file:// URL через стандартный URL.
function fileUrlFor(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');

    if (normalized.startsWith('//')) {
        // UNC-путь: //server/share/path
        const slash = normalized.indexOf('/', 2);
        const host = slash === -1 ? normalized.slice(2) : normalized.slice(2, slash);
        const rest = slash === -1 ? '/' : normalized.slice(slash);
        const url = new URL(`file://${host}/`);
        url.pathname = rest; // setter сам кодирует #, ?, пробелы и кириллицу
        return url.href;
    }

    const url = new URL('file:///');
    url.pathname = normalized.startsWith('/') ? normalized : '/' + normalized;
    return url.href;
}

contextBridge.exposeInMainWorld('api', {
    // Локализация
    getLocales: () => ipcRenderer.invoke('get-locales'),
    setMenuLanguage: (lang) => ipcRenderer.invoke('set-menu-language', lang),
    onLanguageChanged: (cb) => ipcRenderer.on('language-changed', (event, lang) => cb(lang)),

    // Движок (Python)
    runPython: (args) => ipcRenderer.invoke('run-python', args),

    // Файлы и папки
    selectFiles: () => ipcRenderer.invoke('select-files'),
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    loadFolderImages: (folderPath) => ipcRenderer.invoke('load-folder-images', folderPath),
    saveFile: (name) => ipcRenderer.invoke('save-file', name),
    copySvg: (sourcePath, targetPath) => ipcRenderer.invoke('copy-svg', sourcePath, targetPath),
    openFolder: (which) => ipcRenderer.invoke('open-folder', which),

    // PhotoCraft
    testPhotoCraft: () => ipcRenderer.invoke('test-photocraft'),
    launchPhotoCraft: () => ipcRenderer.invoke('launch-photocraft'),
    diagnosePhotoCraft: () => ipcRenderer.invoke('diagnose-photocraft'),
    choosePhotoCraftPath: () => ipcRenderer.invoke('choose-photocraft-path'),
    sendToPhotoCraft: (subpaths, width, height) => ipcRenderer.invoke('send-subpaths-to-photocraft', subpaths, width, height),

    // URL
    pathToFileURL: (filePath) => {
        try {
            return fileUrlFor(filePath);
        } catch (e) {
            console.error("pathToFileURL error:", e);
            return filePath; // fallback
        }
    }
});
