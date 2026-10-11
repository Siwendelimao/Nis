@echo off
REM =====================================================================
REM  ar.cmd -- wrapper for Agent Reach (used by NIS)
REM
REM  Why: agent-reach and its upstream tools (yt-dlp / bili-cli / gh / curl)
REM  are plain CLI programs. They do NOT read the browser proxy setting, and
REM  they do NOT know NIS private node/python paths. Called bare, you get
REM  "not installed" for tools and connection failures for foreign sites.
REM
REM  What it does: set proxy env, prepend venv + portable node to PATH,
REM  then run the command passed in.
REM
REM  Usage examples:
REM    ar.cmd agent-reach doctor
REM    ar.cmd yt-dlp --skip-download --print title VIDEO_URL
REM    ar.cmd curl -s https://r.jina.ai/WEBSITE
REM    ar.cmd bili-cli search keyword
REM
REM  Notes: api.github.com and github.com are in NO_PROXY (proxy gives 403).
REM  Keep all comments free of shell metacharacters: lt gt pipe amp percent.
REM =====================================================================
setlocal
REM  ★1010f: values can be overridden by the caller (server injects from settings).
if not defined HTTP_PROXY set "HTTP_PROXY=http://127.0.0.1:7897"
if not defined HTTPS_PROXY set "HTTPS_PROXY=http://127.0.0.1:7897"
if not defined NO_PROXY set "NO_PROXY=api.github.com,github.com,localhost,127.0.0.1"
REM  python CLIs crash with UnicodeEncodeError on CP936 consoles without these
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
set "PATH=%USERPROFILE%\.agent-reach-venv\Scripts;%USERPROFILE%\.ar-node\node-v22.23.3-win-x64;%PATH%"
REM  call is REQUIRED: npm/other tools are .cmd files, calling them bare would
REM  hand over control and stop this wrapper (and the caller) silently.
call %*
