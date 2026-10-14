@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/2] 正在构建...
call npm run build
if errorlevel 1 (
  echo 构建失败，请检查 Node.js 环境
  pause
  exit /b 1
)
echo [2/2] 启动应用...
set ELECTRON_RUN_AS_NODE=
"%~dp0node_modules\electron\dist\electron.exe" .
