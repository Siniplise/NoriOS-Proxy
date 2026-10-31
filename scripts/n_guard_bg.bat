@echo off
rem ===================================================================
rem  n_guard_bg.bat  -  start / restart ONLY the audio-guard proxy (:4173)
rem
rem  Why this file exists:
rem    n_guard.bat runs `node nori_proxy.js` in the FOREGROUND, and
rem    nori_start_all.bat runs it detached but also tears down + restarts the
rem    whole stack. Neither can "just restart 4173" non-interactively.
rem    This is the same command nori_start_all.bat uses for step [4/5].
rem
rem  Detached on purpose (start /min) => it keeps running after the caller exits.
rem  Persona (:25503) is NEVER touched. Nothing else is killed.
rem
rem  NOTE: keep this file PURE ASCII (non-ASCII bytes break cmd parsing).
rem ===================================================================
setlocal EnableExtensions
set "W=%~dp0."
cd /d "%W%"

rem --- fallback LLM key (single source: _local_key.txt, never echoed) ---
set "DKEY="
if exist "_local_key.txt" for /f "usebackq delims=" %%k in ("_local_key.txt") do set "DKEY=%%k"
if not defined DKEY echo [warn] _local_key.txt missing - DeepSeek fallback key unavailable

rem --- kill whatever currently holds 4173 (that pid only) ---
for /f "tokens=5" %%p in ('netstat -ano -p tcp ^| findstr "LISTENING" ^| findstr ":4173 "') do (
  echo [guard] killing stale 4173 pid %%p
  taskkill /F /PID %%p >nul 2>&1
)
ping -n 2 127.0.0.1 >nul

set "DEEPSEEK_API_KEY=%DKEY%"
start "nori-guard" /min /d "%W%" cmd /c "node nori_proxy.js >> proxy.log 2>&1"
ping -n 4 127.0.0.1 >nul

echo [guard] 4173 socket:
netstat -ano -p tcp | findstr "LISTENING" | findstr ":4173 "
goto :eof
