# Ricerca TKT — Estensione Chrome / Edge

Applicazione dedicata in una scheda del browser per cercare e leggere **ticket**, **Knowledge Base** e **FAQ** di **HDA TOUCH** (`https://zucchetti.support/HDAPortal/`) — oltre a **Vecchio Cruscotto** e **Ricerca avanzata** dell'Area Riservata — con **tema scuro (blu notte)** e **tema chiaro (bianco e blu)**, barra rapida delle **Date** sopra i risultati, **estrazione completa della storia ticket in `.txt`**, anteprima/download diretto degli allegati e **aggiornamenti automatici**.

Opera esclusivamente in **sola lettura** usando la sessione già aperta nel browser: leggere un ticket, un articolo KB o una FAQ non blocca mai il record su HDA Touch per gli altri operatori.

## Struttura del repository

- `extension/` — **l'estensione Chrome / Edge** (è la cartella da caricare in `edge://extensions` o `chrome://extensions`).
- `updater/` — script per l'**aggiornamento automatico** da dentro l'estensione (`attiva_autoaggiornamento.bat`, `disattiva_autoaggiornamento.bat`).
- `aggiorna.bat` — aggiornamento rapido per chi usa un clone Git.

Per la guida completa alle funzionalità e ai dettagli tecnici vedi [extension/README.md](extension/README.md).

## Installazione rapida (Edge o Chrome)

1. Scarica (o clona) questa cartella sul PC.
2. Apri `edge://extensions` (oppure `chrome://extensions`).
3. Attiva **Modalità sviluppatore**.
4. Premi **Carica estensione non pacchettizzata** (*Load unpacked*) e seleziona la cartella `extension`.
5. Fissa l'icona **Ricerca TKT** nella barra del browser (o usa `Alt+Maiusc+T`).

## Aggiornamenti automatici

Per far aggiornare automaticamente l'estensione ogni 4 ore (o con un clic dalla sezione **Aggiornamenti** nella barra sinistra, senza permessi amministratore):

1. Esegui una sola volta `updater\attiva_autoaggiornamento.bat`.
2. In Ricerca TKT apri **Aggiornamenti** per verificare lo stato o forzare un controllo immediato.

Per disattivare l'aggiornamento automatico esegui `updater\disattiva_autoaggiornamento.bat`.

## Test e sviluppo locale

```bash
# Test unitari (Node 20+)
node --test extension/test/*.test.mjs

# Portale finto con dati sintetici per provare l'interfaccia in locale
python3 extension/dev/mock_server.py 8765
# → http://localhost:8765/app/index.html
```
