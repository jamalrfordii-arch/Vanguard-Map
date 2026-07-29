@echo off
title VANGUARD1 — Flight Proxy
echo ============================================
echo  VANGUARD1 Flight Proxy  ^|  Auto-Restart
echo ============================================
echo.

:loop
echo [%TIME%] Starting flight-proxy.js...
node "%~dp0flight-proxy.js"
echo.
echo [%TIME%] Proxy exited (crash or stop). Restarting in 3 seconds...
echo  Press Ctrl+C to stop permanently.
timeout /t 3 /nobreak >nul
echo.
goto loop
