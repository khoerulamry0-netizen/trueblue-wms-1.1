@echo off
title TrueBlue WMS - Local Development
cd /d "c:\WMS-GITHUB\amri\development\trueblue-wms"

echo ===================================================
echo   Memulai TrueBlue WMS Development Server...
echo ===================================================
echo.

start "" "http://localhost:5173"
npm.cmd run dev

pause
