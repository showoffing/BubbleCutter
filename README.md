# Bubble Cutter Pro

**ПО для перевода манги**, оптимизированное для слабых ПК: не требует мощных
видеокарт — поиск пузырей речи выполняется **локально** (нейросеть YOLO) и с
помощью эвристик (flood-fill), без облачных сервисов и тяжёлых GPU-моделей.

Вырезает пузыри речи, векторизует их в SVG и отправляет контуры в **PhotoCraft**
через локальный **Control Channel** (TCP-мост, порт `7878`).

- **Движок** — Python (`engine.py` + модель `bubbles_detect.pt`)
- **UI** — Electron (тёмная тема, RU/EN)
- **Сборка** — `electron-builder` (портативный `.exe` для Windows)

> **Лицензия: AGPL-3.0.** Проект использует модель YOLO, поэтому
> распространяется на условиях GNU Affero General Public License v3.0.
> Полный текст — в [`LICENSE`](LICENSE).

---

## Возможности

- Три вкладки над холстом: **Контуры** · **PhotoCraft** · **Диагностика**
- Загрузка одиночных файлов или всей папки (png, jpg, webp, svg)
- Миниатюры в списке файлов
- Автопоиск пузырей (YOLO) и ручная расстановка точек (flood-fill + векторизация)
- Предпросмотр маски с зумом и панорамированием
- Сохранение в SVG, отправка контуров в PhotoCraft (`shape.create`)
- Полная локализация интерфейса и меню (Русский / English)
- Режимы после сохранения: перейти к следующему или остаться на текущем
- Собственная иконка окна и `.exe`

---

## Структура репозитория

```
.
├── main.js              # Точка входа Electron: окно, меню, IPC, мост PhotoCraft, движок
├── preload.js           # Безопасный мост window.api → IPC
├── renderer.js          # Логика UI: вкладки, canvas, зум, точки, предпросмотр
├── index.html           # Разметка
├── style.css            # Тёмная тема
├── package.json         # Метаданные и конфиг electron-builder
├── package-lock.json    # Зафиксированные версии зависимостей
├── icon/
│   └── bubble.ico       # Иконка приложения (16–256 px)
├── locales/
│   ├── en.json          # Английские строки
│   └── ru.json          # Русские строки
├── python/
│   ├── engine.py        # Движок: детекция пузырей + векторизация
│   ├── bubbles_detect.pt # Модель YOLO (~22 МБ)
│   └── engine.exe       # ОПЦИОНАЛЬНО: автономный движок (без Python)
├── CHANGELOG.md         # История изменений
├── LICENSE              # AGPL-3.0
└── .gitignore
```

> Папка `release/` (артефакты релиза) **не** входит в репозиторий — она в
> `.gitignore`. Файл `.exe` прикрепляется к релизу GitHub отдельно.

---

## Сборка

Требуется **Node.js 20+**. Зависимости ставятся один раз:

```powershell
npm install
```

Собрать портативный `.exe`:

```powershell
npm run build
# результат: dist/BubbleCutter <version>.exe
```

### Автономный движок (без Python)

По умолчанию `.exe` запускает `python/engine.py` через системный Python.
Чтобы релиз работал на машине без Python, соберите движок в исполняемый файл
и положите его рядом с `engine.py`:

```powershell
py -3.12 -m pip install pyinstaller opencv-python-headless numpy ultralytics torch vtracer
py -3.12 -m PyInstaller --onefile --name engine engine.py
copy dist\engine.exe python\engine.exe
```

После этого `main.js` найдёт `python/engine.exe` (через `extraResources`) и будет
использовать его вместо `python engine.py`.

---

## Запуск в режиме разработки

```powershell
npm install
npm start
```

Для работы движка в режиме разработки нужен Python 3.12:

```powershell
winget install Python.Python.3.12
py -3.12 -m pip install opencv-python-headless numpy ultralytics torch vtracer
```

---

## Интеграция с PhotoCraft (Control Channel)

Приложение управляет PhotoCraft через локальный **Control Channel** — TCP-мост на
порту `7878` с авторизацией по токену (`control.token`). Контуры отправляются
командой `shape.create` через этот канал. Путь к `photocraft.exe` хранится в
`userData/photocraft_path.json`; если файл не найден по стандартному пути,
приложение предложит выбрать его вручную.

---

## Релизы

Готовые `.exe` публикуются на странице
[Releases](https://github.com/showoffing/BubbleCutter/releases) с контрольной
суммой SHA-256. См. [`CHANGELOG.md`](CHANGELOG.md).
