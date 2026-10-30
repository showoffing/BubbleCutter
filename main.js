// ----------  ИМПОРТЫ  ----------
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');

// ----------  ПУТИ В userData  ----------
const userDataPath = app.getPath('userData');
const PHOTOTOOL_PATH = path.join(userDataPath, 'photocraft_path.json');
const VERSION_FILE = path.join(userDataPath, 'version.txt');

// ----------  ГЛОБАЛЬНЫЕ КОНСТАНТЫ  ----------
const BRIDGE_PORT = 7878;
const BRIDGE_TIMEOUT_MS = 15000;
const PHOTOCRAFT_LAUNCH_TIMEOUT_MS = 20000;
const PHOTOCRAFT_CANVAS = { width: 1920, height: 1080 };

// Путь по умолчанию; перезаписывается сохранённым (photocraft_path.json)
let PHOTOCRAFT_EXE = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PhotoCraft', 'photocraft.exe');

try {
    if (fs.existsSync(PHOTOTOOL_PATH)) {
        const data = JSON.parse(fs.readFileSync(PHOTOTOOL_PATH, 'utf8'));
        if (data.path && fs.existsSync(data.path)) {
            PHOTOCRAFT_EXE = data.path;
        }
    }
} catch (e) {
    console.error('Ошибка чтения сохранённого пути к PhotoCraft:', e);
}

function bridgeDir() {
    return path.join(userDataPath, 'photocraft-bridge');
}

// ----------  МОСТ PHOTOCRAFT  ----------
function sendToPhotoCraft(command, params = {}, timeoutMs = BRIDGE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const tokenPath = path.join(bridgeDir(), 'control.token');
        if (!fs.existsSync(tokenPath)) return reject(new Error("PhotoCraft не запущен в режиме моста!"));

        const token = fs.readFileSync(tokenPath, 'utf8').trim();
        const client = new net.Socket();
        let buffer = '';
        let settled = false;
        let timer;

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client.destroy();
            fn(value);
        };
        const fail = (err) => finish(reject, err instanceof Error ? err : new Error(String(err)));

        timer = setTimeout(
            () => fail(new Error(`Таймаут: PhotoCraft не ответил за ${timeoutMs} мс`)),
            timeoutMs
        );

        client.connect(BRIDGE_PORT, '127.0.0.1', () => {
            client.write(JSON.stringify({ id: "auth", method: "auth", params: { token } }) + '\n');
        });

        client.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line) continue;

                let response;
                try { response = JSON.parse(line); } catch (e) { continue; }

                if (response.id === "auth") {
                    if (!response.ok) {
                        return fail(new Error("Авторизация в PhotoCraft не удалась: " + JSON.stringify(response)));
                    }
                    client.write(JSON.stringify({
                        id: "cmd_1",
                        method: "engine.execute",
                        params: { command: command, params: params }
                    }) + '\n');
                } else if (response.id === "cmd_1") {
                    return finish(resolve, response);
                }
            }
        });

        client.on('error', fail);
        client.on('close', () => fail(new Error("PhotoCraft закрыл соединение до ответа")));
    });
}

function launchPhotoCraftWithBridge() {
    return new Promise((resolve) => {
        const dir = bridgeDir();
        const tokenPath = path.join(dir, 'control.token');

        if (!fs.existsSync(PHOTOCRAFT_EXE)) {
            return resolve({ success: false, needsPath: true, error: `PhotoCraft не найден: ${PHOTOCRAFT_EXE}` });
        }
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        let previousMtime = 0;
        try { previousMtime = fs.statSync(tokenPath).mtimeMs; } catch (e) { /* файла нет */ }

        let poll = null;
        let settled = false;

        const done = (result) => {
            if (settled) return;
            settled = true;
            if (poll) clearInterval(poll);
            resolve(result);
        };

        try {
            const child = spawn(PHOTOCRAFT_EXE, [
                '--control', String(BRIDGE_PORT),
                '--control-token-file', tokenPath,
                '--automation-read-root', dir,
                '--automation-write-root', dir,
            ], { detached: true, stdio: 'ignore', windowsHide: false });

            child.on('error', (err) => {
                done({ success: false, error: 'Не удалось запустить PhotoCraft: ' + err.message });
            });
            child.unref();
        } catch (e) {
            return resolve({ success: false, error: e.message });
        }

        const startedAt = Date.now();
        poll = setInterval(() => {
            let fresh = false;
            try { fresh = fs.existsSync(tokenPath) && fs.statSync(tokenPath).mtimeMs > previousMtime; }
            catch (e) { fresh = false; }

            if (fresh) {
                done({ success: true, message: "PhotoCraft запущен!" });
            } else if (Date.now() - startedAt > PHOTOCRAFT_LAUNCH_TIMEOUT_MS) {
                done({
                    success: false,
                    error: `PhotoCraft запущен, но токен моста не появился за ${PHOTOCRAFT_LAUNCH_TIMEOUT_MS / 1000} с.`
                });
            }
        }, 300);
    });
}

// ----------  МЕНЮ (локализация)  ----------
let currentLang = 'ru';

function loadMenuStrings(lang) {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', lang + '.json'), 'utf8'));
        return data.menu || {};
    } catch (e) {
        console.error('Ошибка чтения меню локализации:', e);
        return {};
    }
}

function buildMenu() {
    const m = loadMenuStrings(currentLang);

    const template = [
        {
            label: m.file || 'File',
            submenu: [
                { label: m.exit || 'Exit', role: 'quit' },
            ],
        },
        {
            label: m.edit || 'Edit',
            submenu: [
                { label: m.undo || 'Undo', role: 'undo' },
                { label: m.redo || 'Redo', role: 'redo' },
                { type: 'separator' },
                { label: m.cut || 'Cut', role: 'cut' },
                { label: m.copy || 'Copy', role: 'copy' },
                { label: m.paste || 'Paste', role: 'paste' },
            ],
        },
        {
            label: m.view || 'View',
            submenu: [
                { label: m.toggle_language || 'Toggle Language', click: toggleLanguage },
            ],
        },
        {
            label: m.help || 'Help',
            submenu: [
                { label: m.about || 'About', click: showAbout },
            ],
        },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function toggleLanguage() {
    currentLang = currentLang === 'ru' ? 'en' : 'ru';
    buildMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('language-changed', currentLang);
    }
}

function showAbout() {
    const m = loadMenuStrings(currentLang);
    const version = app.getVersion();
    const detail = (m.about_version || 'Version {version}').replace('{version}', version);
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: m.about || 'About',
        message: m.about_message || 'Bubble Cutter Pro',
        detail: detail,
        buttons: ['OK'],
    });
}

ipcMain.handle('set-menu-language', (event, lang) => {
    if (lang === 'ru' || lang === 'en') {
        currentLang = lang;
        buildMenu();
    }
    return currentLang;
});

// ----------  ЛОКАЛИЗАЦИЯ  ----------
ipcMain.handle('get-locales', () => {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', name), 'utf8'));
    return { ru: read('ru.json'), en: read('en.json') };
});

// ----------  ПУТЬ К PHOTOCRAFT  ----------
ipcMain.handle('choose-photocraft-path', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'PhotoCraft', extensions: ['exe'] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
    }
    const selectedPath = result.filePaths[0];
    if (!selectedPath.toLowerCase().endsWith('photocraft.exe')) {
        return { success: false, error: "Выберите photocraft.exe" };
    }
    try {
        fs.writeFileSync(PHOTOTOOL_PATH, JSON.stringify({ path: selectedPath }), 'utf8');
        PHOTOCRAFT_EXE = selectedPath;
        return { success: true, path: selectedPath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ----------  ДИАЛОГИ (файлы/папки)  ----------
ipcMain.handle('select-files', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] }]
    });
    return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory']
    });
    return result.canceled ? { canceled: true } : { canceled: false, folderPath: result.filePaths[0] };
});

ipcMain.handle('load-folder-images', async (event, folderPath) => {
    try {
        const files = await fs.promises.readdir(folderPath);
        const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.svg'];
        const imageFiles = files
            .filter(f => imageExts.includes(path.extname(f).toLowerCase()))
            .map(f => path.join(folderPath, f));
        return { success: true, files: imageFiles };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('save-file', async (event, defaultName) => {
    const result = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters: [{ name: 'SVG', extensions: ['svg'] }]
    });
    return result.canceled ? null : result.filePath;
});

ipcMain.handle('copy-svg', async (event, sourcePath, targetPath) => {
    try {
        const tempRoot = path.resolve(app.getPath('temp')) + path.sep;
        const source = path.resolve(sourcePath);

        if (!source.startsWith(tempRoot)) {
            return { success: false, error: "Источник должен быть во временной папке." };
        }
        if (!fs.existsSync(source)) {
            return { success: false, error: "Файл предпросмотра не найден. Сделай предпросмотр заново." };
        }

        fs.copyFileSync(source, targetPath);
        return { success: true, path: targetPath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('open-folder', async (event, which) => {
    try {
        const targets = { bridge: bridgeDir(), temp: app.getPath('temp') };
        const targetPath = targets[which];
        if (!targetPath) return { success: false, error: "Неизвестная папка" };

        if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
        const openError = await shell.openPath(targetPath);
        if (openError) return { success: false, error: openError };
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ----------  PYTHON-ДВИЖОК  ----------
const PYTHON_MAX_BUFFER = 64 * 1024 * 1024;

function enginePaths() {
    const root = app.isPackaged ? process.resourcesPath : __dirname;
    return {
        script: path.join(root, 'python', 'engine.py'),
        exe: path.join(root, 'python', 'engine.exe'),
    };
}

function parseEngineOutput(stdout) {
    const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        try { return JSON.parse(lines[i]); } catch (e) { /* не JSON */ }
    }
    return null;
}

ipcMain.handle('run-python', async (event, args) => {
    return new Promise((resolve) => {
        try {
            if (!args || typeof args !== 'object') {
                return resolve({ error: "Некорректные аргументы движка" });
            }

            if (args.output_svg_path && !path.isAbsolute(args.output_svg_path)) {
                args.output_svg_path = path.join(app.getPath('temp'), args.output_svg_path);
            }

            const payload = JSON.stringify(args);
            const { script, exe } = enginePaths();
            const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
            const options = { maxBuffer: PYTHON_MAX_BUFFER, env, windowsHide: true };

            const done = (error, stdout, stderr) => {
                if (error) {
                    if (error.code === 'ENOENT') {
                        return resolve({
                            error: "Python не найден. Установи Python 3 или собери engine.exe (PyInstaller)."
                        });
                    }
                    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                        return resolve({ error: "Слишком большой ответ движка (maxBuffer)." });
                    }
                    const detail = (stderr || '').trim();
                    return resolve({ error: detail || error.message });
                }

                const parsed = parseEngineOutput(stdout);
                if (!parsed) {
                    return resolve({ error: "Ошибка разбора ответа движка: " + stdout.slice(0, 300) });
                }
                resolve(parsed);
            };

            if (fs.existsSync(exe)) {
                return execFile(exe, [payload], options, done);
            }

            execFile('python', [script, payload], options, (error, stdout, stderr) => {
                if (error && error.code === 'ENOENT') {
                    execFile('py', [script, payload], options, done);
                } else {
                    done(error, stdout, stderr);
                }
            });
        } catch (e) {
            resolve({ error: e.message });
        }
    });
});

// ----------  PHOTOCRAFT: ОБРАБОТЧИКИ  ----------
ipcMain.handle('test-photocraft', async () => {
    try {
        const response = await sendToPhotoCraft('file.new', {});
        return { success: true, data: response };
    } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('launch-photocraft', async () => {
    try {
        if (!fs.existsSync(PHOTOCRAFT_EXE)) {
            return { success: false, needsPath: true, error: `PhotoCraft не найден: ${PHOTOCRAFT_EXE}` };
        }
        return await launchPhotoCraftWithBridge();
    } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('diagnose-photocraft', async () => {
    const results = {};
    const probes = {
        engine_commands: 'engine.commands',
        command_list: 'command.list',
        ui_inspect: 'ui.inspect',
    };

    for (const [key, command] of Object.entries(probes)) {
        try { results[key] = await sendToPhotoCraft(command, {}); }
        catch (e) { results[key] = { error: e.message }; }
    }

    return { success: true, data: results };
});

function centerSubpaths(subpaths, imgW, imgH) {
    const offsetX = (PHOTOCRAFT_CANVAS.width - (imgW || 0)) / 2;
    const offsetY = (PHOTOCRAFT_CANVAS.height - (imgH || 0)) / 2;

    return subpaths.map(sp => ({
        closed: sp.closed !== false,
        knots: (sp.knots || []).map(([x, y]) => [
            Math.round(x + offsetX),
            Math.round(y + offsetY),
        ]),
    }));
}

ipcMain.handle('send-subpaths-to-photocraft', async (event, subpaths, imgW, imgH) => {
    try {
        if (!Array.isArray(subpaths) || subpaths.length === 0) {
            return { success: false, error: "Нет контуров для отправки. Сделай предпросмотр." };
        }

        const params = {
            kind: "path",
            path: { subpaths: centerSubpaths(subpaths, imgW, imgH) },
            fill: "#ffffff",
            stroke: { width: 2, color: "#000000", align: "inside" }
        };
        console.log(`Отправляем shape.create: ${subpaths.length} контур(ов)`);

        const result = await sendToPhotoCraft('shape.create', params);
        if (!result.ok) {
            return { success: false, error: "shape.create: " + JSON.stringify(result) };
        }
        return { success: true, data: result };
    } catch (error) { return { success: false, error: error.message }; }
});

// ----------  ОКНО  ----------
let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1300,
        height: 900,
        icon: path.join(__dirname, 'icon', 'bubble.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            mainWindow.webContents.toggleDevTools();
            event.preventDefault();
        }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
    // Записываем версию в userData при первом запуске
    try {
        if (!fs.existsSync(VERSION_FILE)) {
            fs.writeFileSync(VERSION_FILE, app.getVersion() || '1.0.1', 'utf8');
        }
    } catch (e) {
        console.error('Ошибка записи version.txt:', e);
    }
    buildMenu();
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
