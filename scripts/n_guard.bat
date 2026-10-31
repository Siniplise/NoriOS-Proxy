@echo off
rem restart just the audio guard proxy (:4173) with the fallback LLM key
cd /d "%~dp0"
rem 2026-10-04: unified to env var DEEPSEEK_API_KEY (value read from _local_key.txt)
set "DEEPSEEK_API_KEY="
if exist "_local_key.txt" for /f "usebackq delims=" %%k in ("_local_key.txt") do set "DEEPSEEK_API_KEY=%%k"
if not defined DEEPSEEK_API_KEY echo [warn] _local_key.txt missing - DeepSeek fallback key unavailable
set NORI_FALLBACK_MODEL=deepseek-flash
node nori_proxy.js >> proxy.log 2>&1
