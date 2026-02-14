@echo off
title K.Lorayne Apparel — CRM Dashboard
echo ═══════════════════════════════════════════
echo   K.Lorayne Apparel CRM Dashboard
echo ═══════════════════════════════════════════
echo.
echo Starting server...

cd /d "%~dp0"

:: Check Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: Node.js is not installed on this computer.
    echo.
    echo Please download and install it from:
    echo   https://nodejs.org/
    echo.
    echo Choose the LTS version, install it, then try again.
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies for the first time...
    npm install
    echo.
)

echo.
echo Server is starting. Your browser will open shortly...
echo.
echo ─────────────────────────────────────────
echo   DO NOT CLOSE THIS WINDOW while
echo   using the dashboard.
echo ─────────────────────────────────────────
echo.

:: Start server and open browser after a short delay
start "" http://localhost:3456
node src/server.js

echo.
echo Server stopped.
pause
