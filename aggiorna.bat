@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist ".git" (
  echo Aggiornamento di Ricerca TKT dal branch main tramite Git...
  git pull --ff-only origin main
  if errorlevel 1 (
    echo.
    echo Errore durante git pull. Controlla la connessione o le credenziali GitHub.
  ) else (
    echo.
    echo Aggiornato! Torna in Ricerca TKT e premi "Ricarica estensione" in Diagnostica ^(o ricarica da edge://extensions^).
  )
) else (
  echo Questa cartella non e un clone Git.
  echo Per aggiornare automaticamente direttamente da dentro Edge/Chrome senza passare da GitHub,
  echo esegui una sola volta: updater\attiva_autoaggiornamento.bat
)
echo.
pause
