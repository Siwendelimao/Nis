@echo off
setlocal enabledelayedexpansion
title NIS frontend build (uses NIS bundled node)

set "NODE=D:\NIS\pack\node.exe"
set "FE=D:\nis0924\frontend"
set "DIST=%FE%\dist"
set "PKGDIST=D:\NIS\pack\dist"
set "LOG=D:\nis0924\_build_frontend.log"

echo ================================================================
echo   NIS frontend build  (no node/npm install needed)
echo   node : %NODE%
echo   src  : %FE%
echo   log  : %LOG%
echo ================================================================
echo.

if not exist "%NODE%" (
  echo [X] missing %NODE%
  pause
  exit /b 1
)
if not exist "%FE%\node_modules\vite\bin\vite.js" (
  echo [X] missing %FE%\node_modules\vite\bin\vite.js
  pause
  exit /b 1
)

cd /d "%FE%"

set "EXTRA="
if /i "%~1"=="debug" set "EXTRA=--minify false --sourcemap false"
if defined EXTRA echo [note] debug mode: minify off, sourcemap off

echo [1/3] building... (1-5 min, silence in between is normal)
"%NODE%" --max-old-space-size=8192 node_modules\vite\bin\vite.js build %EXTRA% > "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo       exit code = %RC%

if not "%RC%"=="0" goto FAIL
if not exist "%DIST%\index.html" goto NODIST
echo       [OK] build succeeded
echo.

echo [2/3] backup current installed frontend
if exist "%PKGDIST%" (
  if not exist "%PKGDIST%.bak-0921" (
    xcopy /e /i /q /y "%PKGDIST%" "%PKGDIST%.bak-0921" >nul
    echo       backed up to %PKGDIST%.bak-0921
  ) else (
    echo       backup already exists, skipped
  )
) else (
  echo       no installed dist, backup skipped
)

echo.
echo [3/3] deploy to installed frontend
if not exist "%PKGDIST%" mkdir "%PKGDIST%"
xcopy /e /i /q /y "%DIST%\*" "%PKGDIST%\" >nul
if not exist "%PKGDIST%\index.html" (
  echo [X] deploy failed
  pause
  exit /b 1
)
echo       done
echo.
echo ================================================================
echo  [ALL DONE] restart NIS now. Settings - Providers - model edit
echo             will show the new "Max output / Max input" fields.
echo ================================================================
pause
exit /b 0

:NODIST
echo [X] vite reported no error but %DIST%\index.html is missing
goto SHOWLOG

:FAIL
echo.
echo [X] BUILD FAILED
:SHOWLOG
echo ----------------------------------------------------------------
echo   last 20 lines of the log (send these to Nis):
echo ----------------------------------------------------------------
powershell -NoProfile -Command "Get-Content -LiteralPath '%LOG%' -Tail 20"
echo ----------------------------------------------------------------
echo.
echo   exit code -1073740791 (0xC0000409) or 3221225477 = native crash
echo   workaround 1: just run it again (sometimes transient)
echo   workaround 2: run with debug arg, for example:  build-frontend.bat debug
echo   workaround 3: send the log tail above to Nis
echo.
pause
exit /b 1
