@echo off
echo ==========================================
echo       喵杀 (MEOWCHA) 一键启动脚本
echo ==========================================

REM 检查是否安装了 pnpm
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] 未检测到 pnpm，正在尝试安装...
    npm install -g pnpm
    if %errorlevel% neq 0 (
        echo [x] pnpm 安装失败，请确保已安装 Node.js。
        pause
        exit /b
    )
)

REM 检查依赖是否已安装
if not exist "node_modules" (
    echo [*] 正在安装项目依赖...
    call pnpm install
) else (
    echo [*] 依赖已安装，跳过安装步骤。
)

echo.
echo [*] 正在启动开发服务器...
echo [*] 启动成功后，请在浏览器访问: http://localhost:3000
echo.

call pnpm dev

pause
