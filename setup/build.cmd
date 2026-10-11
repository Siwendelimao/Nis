@echo off
setlocal enableextensions
chcp 65001 >nul 2>&1
rem ============================================================================
rem  NIS build ONE-CLICK  (run this OUTSIDE the AI agent's shell!)
rem
rem  Why: when the build is launched from the AI agent's Bash tool, the tool's
rem  sandbox DLL (tsbx.dll) is injected into cargo / rustc / tauri-build /
rem  makensis. Every file operation then goes through the sandbox broker and waits
rem  for an approval timeout -- measured as 0% CPU stalls lasting minutes, and the
rem  whole packaging run blowing up from ~5 min to 20-40 min.
rem  Running the very same script from a plain console avoids all of that.
rem
rem  Usage:  double-click, or:  setup\build.cmd
rem          setup\build.cmd --skip-web
rem          setup\build.cmd --no-app
rem ============================================================================

set "ROOT=%~dp0.."
set "NODE=%NIS_NODE%"
if not defined NODE set "NODE=%~dp0..\toolchain\node\node.exe"
if not exist "%NODE%" set "NODE=node"

set "CARGO_HOME=D:\dev\cargo"
set "RUSTUP_HOME=D:\dev\rustup"
set "PATH=D:\dev\bin;D:\dev\cargo\bin;%PATH%"

rem --- jobs: 12 logical cores on this box; 8 is a good default.
rem     If you ever see "os error 5 (Access denied)", drop to 4.
if not defined NIS_CARGO_JOBS set "NIS_CARGO_JOBS=8"

rem --- no local MITM proxy for cargo/tauri (schannel revocation errors)
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "http_proxy="
set "https_proxy="
set "all_proxy="

echo ============================================================
echo   NIS packaging
echo   ROOT  = %ROOT%
echo   NODE  = %NODE%
echo   JOBS  = %NIS_CARGO_JOBS%
echo ============================================================
echo.

"%NODE%" "%ROOT%\setup\_build_all.mjs" --kill-dev %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (echo [OK] done. see exports\ ) else (echo [FAIL] exit=%RC%   see setup\_logs\ )
echo.
pause
exit /b %RC%
