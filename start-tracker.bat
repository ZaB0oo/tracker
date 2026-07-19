@echo off
REM osu! completionist tracker launcher: double-click and go.
REM Builds on first launch (or after a code update), then runs the server in
REM production mode (no npm run dev, no hot reload).
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js 22.13+ is required: https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules call npm install
if not exist dist\server\index.js call npm run build
if not exist web\dist\index.html call npm run build

REM Open the browser once the server is ready (2 s of margin)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3727"

echo.
echo === osu! completionist tracker — http://localhost:3727 ===
echo (closing this window stops the server)
echo.
node dist\server\index.js
pause
