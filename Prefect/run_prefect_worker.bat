@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem Adjust REPO_ROOT if this repo is cloned to a different path on the server.
set "REPO_ROOT=C:\Users\Administrator\Documents\GitHub\day_ahead_prices"
set "PREFECT_DIR=%REPO_ROOT%\Prefect"
set "POETRY_EXE=%APPDATA%\Python\Scripts\poetry.exe"
set "WORKER_LIMIT=3"
set "POOL_NAME=day_ahead_prices"

set "LOG_DIR=%PREFECT_DIR%\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
set "LOGFILE=%LOG_DIR%\prefect_worker.log"
set "MAX_LOG_BYTES=52428800"

if not exist "%REPO_ROOT%" (
    echo [%DATE% %TIME%] ERROR: Repo folder not found: %REPO_ROOT% >> "%LOGFILE%"
    exit /b 1
)
if not exist "%POETRY_EXE%" (
    echo [%DATE% %TIME%] ERROR: Poetry executable not found: %POETRY_EXE% >> "%LOGFILE%"
    exit /b 1
)

cd /d "%REPO_ROOT%"
set "PREFECT_API_URL=http://127.0.0.1:4200/api"

:loop
call :rotate_log
echo [%DATE% %TIME%] Starting %POOL_NAME% worker with limit %WORKER_LIMIT%... >> "%LOGFILE%"
call "%POETRY_EXE%" run prefect worker start --pool "%POOL_NAME%" --limit %WORKER_LIMIT% >> "%LOGFILE%" 2>&1
echo [%DATE% %TIME%] Worker exited with code %ERRORLEVEL%. Restarting in 10 seconds... >> "%LOGFILE%"
timeout /t 10 /nobreak >nul
goto :loop

:rotate_log
if not defined LOGFILE exit /b 0
if not defined MAX_LOG_BYTES exit /b 0
if exist "%LOGFILE%" (
    for %%I in ("%LOGFILE%") do (
        if %%~zI GTR %MAX_LOG_BYTES% (
            if exist "%LOGFILE%.1" del "%LOGFILE%.1" >nul 2>&1
            move /Y "%LOGFILE%" "%LOGFILE%.1" >nul 2>&1
        )
    )
)
exit /b 0
