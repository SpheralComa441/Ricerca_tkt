@echo off
chcp 65001 >nul
echo Rimozione dell'helper di aggiornamento automatico di Ricerca TKT...
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\it.ricercatkt.updater" /f >nul 2>&1
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\it.ricercatkt.updater" /f >nul 2>&1
if exist "%~dp0it.ricercatkt.updater.json" del /f /q "%~dp0it.ricercatkt.updater.json"
echo Fatto: helper rimosso dal registro utente.
echo.
pause
