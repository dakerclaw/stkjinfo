@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   启动项目管理应用...
echo.
if exist "data\app.db" goto run
echo   首次运行，正在初始化数据库与示例数据...
node --no-warnings seed.js
echo.
:run
start "" http://127.0.0.1:5173
node --no-warnings server.js
pause
