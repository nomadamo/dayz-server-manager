# Отчет о прогрессе разработки и миграции (DEV_PROGRESS)

## 1. Текущая цель
Полный аудит кода, миграция синхронных операций с файловой системой (`fs.*Sync`) на асинхронные (`fs.promises.*`), обновление зависимостей (`discord.js` v14, `rxjs`) и обеспечение успешной компиляции проекта.

## 2. Выполненные задачи

### Обновление зависимостей
*   **discord.js**: Обновлен до v14.
    *   В `src/services/discord.ts` добавлены `Partials` в конструктор клиента для корректной обработки событий (реакции на старые сообщения и т.д.).
*   **rxjs**: В `ui/package.json` версия обновлена до `^7.8.2`.

### Миграция на асинхронный FS (fs.promises)
Следующие файлы были рефакторизованы для использования `fs.promises` вместо синхронных вызовов:
*   `src/services/log-reader.ts`
*   `src/services/requirements.ts`
*   `src/services/download.ts`
*   `src/control/manager.ts`
*   `src/interface/ingame-rest.ts`
*   `src/util/compare-folders.ts`
*   `src/services/server-starter.ts`
*   `src/services/monitor.ts`
*   `src/services/paths.ts`
*   `src/services/backups.ts`
*   `src/services/ingame-report.ts`
*   `src/services/syberia-compat.ts`
*   `src/config/config-file-helper.ts`
*   `src/services/config-watcher.ts`
*   `src/services/rcon.ts` (включая методы работы с white/ban листами и GUID)

### Частичная миграция
*   **`src/services/steamcmd.ts`**:
    *   Методы `getWsModName`, `buildWsModParams`, `buildWsServerModParams` переведены на возвращение `Promise`.
    *   Многие методы (`checkSteamCmd`, `updateServer`, `updateMod`) обновлены.
    *   **Проблема:** Остались ошибки компиляции из-за несовпадения типов в местах вызова новых асинхронных методов.

## 3. Текущий статус и проблемы

### Ошибки компиляции в `src/services/steamcmd.ts`
1.  **`checkMods`**: Используется метод массива `.every()` с асинхронным колбэком.
    *   *Суть проблемы:* `.every()` ожидает синхронный возврат `boolean`, но получает `Promise<boolean>`, который всегда истинен (объект).
    *   *Решение:* Переписать на цикл `for ... of` или `Promise.all`.
2.  **`installMod`**: Ошибка `TS2345` в `path.join`.
    *   *Суть проблемы:* Аргумент `modName` предположительно имеет тип `Promise<string>`, а ожидается `string`.
    *   *Решение:* Убедиться, что вызов `this.getWsModName(modId)` ожидается через `await`.
3.  **`sameModMeta`**:
    *   *Статус:* Использует синхронные `fs.existsSync` и `fs.readFileSync`.
    *   *Решение:* Перевести на `fs.promises`.

### Зависимые файлы (требуют обновления)
Так как сигнатуры методов в `SteamCMD` изменились (стали асинхронными), вызовы этих методов в других файлах также нужно обновить (добавить `await`):
*   `src/services/server-starter.ts`: Проверить вызовы `buildWsModParams` и др.
*   `src/control/manager-controller.ts`: Проверить вызовы методов инициализации и обновления модов.

## 4. План действий (Next Steps)

1.  **Исправить `src/services/steamcmd.ts`**:
    *   Заменить `.every()` в `checkMods` на цикл.
    *   Добавить `await` в `installMod` (если отсутствует).
    *   Рефакторинг `sameModMeta` на async.
2.  **Обновить потребителей `SteamCMD`**:
    *   Внести правки в `src/services/server-starter.ts`.
    *   Внести правки в `src/control/manager-controller.ts`.
3.  **Финальная проверка**:
    *   Запустить `npm run build:tsc` и убедиться в отсутствии ошибок типов.
    *   Проверить сборку UI (`npm run build:ui` - опционально, если менялся только бэкенд).

## 5. Окружение
*   **Target Node:** v16 (определено в `pkg`).
*   **TypeScript:** 4.9+ (в devDependencies).
*   **OS:** Linux (текущая среда пользователя).
