@echo off
cd /d "%~dp0"
echo ====================================================
echo           CASER.ONE - ЛОКАЛЬНЫЙ СЕРВЕР
echo ====================================================
echo.
echo [*] Запуск сервера...
echo [*] Открываем браузер: http://localhost:3000/ru/cases
echo [*] НЕ ЗАКРЫВАЙТЕ ЭТО ОКНО!
echo.
start "" "http://localhost:3000/ru/cases"
node server.js
if %errorlevel% neq 0 (
    echo.
    echo [!] Ошибка при запуске. Убедитесь, что установлен Node.js: https://nodejs.org
)
echo.
pause
