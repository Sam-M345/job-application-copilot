@echo off
setlocal
cd /d "%~dp0\.."

set "VENV_PY=%CD%\.venv\Scripts\python.exe"
set "LOG_DIR=%CD%\Logs\copilot"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "LAUNCH_LOG=%LOG_DIR%\launcher.log"

call :log "=== Launcher started ==="
call :log "Working directory: %CD%"

if not exist "%VENV_PY%" (
    call :log "Creating virtual environment..."
    python -m venv .venv
    if errorlevel 1 (
        call :log "ERROR: Failed to create venv"
        echo Failed to create venv. Install Python 3.12+ from python.org
        pause
        exit /b 1
    )
)

echo Job Application Intelligence Copilot
echo.

echo Stopping any previous Streamlit copilot on port 8501...
call :log "Stopping previous Streamlit sessions on port 8501"
powershell -NoProfile -WindowStyle Hidden -Command ^
  "Get-CimInstance Win32_Process | Where-Object {" ^
  "  $_.CommandLine -and $_.CommandLine -match 'streamlit run copilot[\\/]app\.py'" ^
  "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8501" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
    call :log "Killed PID on port 8501: %%a"
)

echo Installing copilot dependencies...
call :log "pip install -r copilot\requirements.txt"
"%VENV_PY%" -m pip install -q -r copilot\requirements.txt
if errorlevel 1 (
    call :log "ERROR: pip install failed"
    echo pip install failed.
    pause
    exit /b 1
)

if not exist ".env" (
    call :log "WARNING: .env not found"
    echo WARNING: .env not found. Add ANTHROPIC_API_KEY to .env in the project root.
    echo.
)

echo Starting Streamlit...
echo Browser should open at http://localhost:8501
echo Close this window to stop the app.
echo Logs: %LOG_DIR%
echo.
call :log "Starting Streamlit with %VENV_PY%"
"%VENV_PY%" -m streamlit run copilot\app.py
if errorlevel 1 (
    call :log "ERROR: Streamlit exited with error code %errorlevel%"
    echo Streamlit exited with an error. See %LAUNCH_LOG% and latest run_*.log
    pause
) else (
    call :log "Streamlit exited normally"
)
exit /b 0

:log
echo %date% %time% %~1>>"%LAUNCH_LOG%"
exit /b 0
