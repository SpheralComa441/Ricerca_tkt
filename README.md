# Ricerca TKT

Motore di ricerca avanzato per i ticket Zucchetti.

I ticket sono più di un milione, quindi non vengono scaricati: ogni ricerca la fa il
**portale ticket Zucchetti (HDAPortal)** sui suoi dati aggiornati, con un numero massimo di
risultati per ricerca. Sopra c'è un'interfaccia più potente: filtri, faccette, ordinamenti e
raggruppamenti sui risultati, esportazione, preferiti con note e ricerche salvate.

| | **Segnalibro** (consigliata) | **Applicazione web** |
|---|---|---|
| Sito | nuovo portale ticket (HDAPortal) | vecchia Area Riservata (indice Solr "Ricerca rapida"), **non aggiornata** |
| Installazione | nessuna: un segnalibro nel browser | server con Python 3.11+ o Docker |
| Accesso | la sessione già aperta nel portale | credenziali Zucchetti o cookie di sessione |
| Dati personali | nel browser (esportabili) | database SQLite sul server |
| Cartella | [`bookmarklet/`](bookmarklet/) | [`app/`](app/), [`static/`](static/) |

## Segnalibro: provalo subito

1. Scarica [`bookmarklet/installa.html`](bookmarklet/installa.html) (su GitHub:
   apri il file → pulsante *Download raw file*) e aprilo con Chrome o Edge.
2. Trascina il pulsante **Ricerca TKT** nella barra dei preferiti
   (<kbd>Ctrl</kbd>+<kbd>Maiusc</kbd>+<kbd>B</kbd> per mostrarla). Se avevi la versione 1,
   sostituisci il vecchio segnalibro.
3. Accedi al portale ticket e clicca il segnalibro: il motore di ricerca si apre sopra la pagina
   (se la scheda **All tickets** non è mai stata aperta, la apre lui). <kbd>Esc</kbd> lo chiude,
   un altro clic sul segnalibro lo riapre.

In alternativa si può incollare il contenuto di
[`bookmarklet/dist/ricerca-tkt.min.js`](bookmarklet/dist/ricerca-tkt.min.js)
nella console del browser (F12 → Console) sulla pagina del portale.

### Come funziona

Il portale è un'applicazione ExtJS. Il segnalibro viene eseguito dentro la pagina, quindi usa la
sessione dell'utente (e il token anti-falsificazione del portale) senza gestire password o cookie:

- cerca sempre in **tutti i ticket**: trova l'elenco **All tickets** (`<id>_UC_ListCt`, classe
  `entity-incident`, nel pannello `body_INC_ALLGRP_EXTENDED` o nella scheda "All tickets"), la sua
  griglia (`<id>_UC_grd`) e il suo archivio dati ExtJS; se la scheda non è mai stata aperta la apre;
- a ogni ricerca imposta i filtri dell'elenco (`<id>_UC_filter_default_FullText`, `Subject`,
  `DateFromFilter`/`DateToFilter`, `LastUpdateDate…`, `StatusFilter`, `PriorityFilter`,
  `CatalogItemTxt`, `ClassCliTxt` e i filtri di gruppi e persone `AssignedUserOrGroupFilter`,
  `OwnerUserGroupID`, `ModifiedBy`, `OwnerUserID`) e chiede al massimo 200 righe (si cambia dalla
  barra di ricerca o in Impostazioni);
- aspetta che il portale ricarichi l'elenco da solo; se non lo fa preme Invio nel campo
  *Search* e, come ultima possibilità, ricarica l'archivio dell'elenco; il modo che ha funzionato
  viene ricordato per le ricerche successive;
- legge i ticket dall'archivio, usando le colonne della griglia (ID, Date, Site, Subject con il
  riepilogo *Issue/Request* e *Resolution*, Status, Priority, Service, Classification,
  Assigned to, Owner Group, Last update…), anche per le righe che la griglia non ha disegnato;
- controlla che la richiesta inviata dal portale contenga il testo cercato e avvisa se no.

Lo stato predefinito è **tutti gli stati** (la pagina del portale di solito mostra solo quelli
aperti). Il portale ordina per data, quindi arrivano i ticket **più recenti**: quando ce ne sono di
più, **Quanti per anno?** conta i ticket della ricerca anno per anno (una richiesta per anno, solo
fino a coprire il totale) e con un clic si cerca in un anno solo.

**Gruppi e persone** (*Assegnato a* persona o gruppo, *Gruppo proprietario*, *Modificato da* cioè
chi ha lavorato il ticket, *Responsabile*) sono filtri del portale, quindi valgono su tutti i
ticket: i nomi si cercano direttamente dal pannello con la ricerca del portale, oppure con
**Scegli nel portale…** si usa il menu del portale (il pannello si nasconde e si riapre dopo la
scelta). Restano nelle ricerche salvate. Sui risultati ci sono anche le faccette per gruppo,
assegnatario, responsabile e "modificato da".

Gli altri filtri impostati nella pagina (Servizio, Sede, Contatto…) restano
attivi e sono mostrati nel pannello. Dopo una ricerca l'elenco del portale mostra la stessa
ricerca: **Ripristina il portale** rimette i filtri e le righe per pagina di prima. **Apri** su un
risultato apre il ticket con il pulsante *Open* della pagina; se il ticket non è più nell'elenco
(ad esempio un preferito) usa *Find by ID…*, compilato e confermato.

Il pannello è isolato in uno *shadow DOM*: non modifica il portale e non ne eredita gli stili; la
pagina sotto resta inattiva finché il pannello è aperto, e il controllo di inattività del portale
viene informato che l'utente sta lavorando. I testi dei ticket sono resi come testo, quindi
l'HTML della griglia non viene mai iniettato nel pannello.

In **Impostazioni** si trovano lo stato del collegamento (elenco usato, colonne riconosciute,
filtri gestiti, come è partita l'ultima ricerca), **Leggi l'elenco attuale della pagina**, il
massimo di ticket per ricerca, **Copia/Scarica dati tecnici** ed esportazione/importazione dei
dati personali. I dati tecnici descrivono l'elenco del portale (archivio, colonne, filtri,
richieste osservate) senza cookie né token; nomi e testi sono sostituiti da «N car.».

### Sviluppo del segnalibro

Il sorgente è [`bookmarklet/src/ricerca-tkt.js`](bookmarklet/src/ricerca-tkt.js).
Dopo una modifica rigenera `dist/` e `installa.html` (serve Node.js ed esbuild):

```bash
cd bookmarklet && npm i --no-save esbuild@0.24.0 && node build.mjs
```

La prova completa usa un finto portale con ExtJS vero (versione GPL, non inclusa nel
repository) e dati inventati: stesse schede del portale (My tickets, My Group Tickets, Tickets
from my groups, All tickets, anche creata solo alla prima apertura con `?lazy=1`), token
anti-falsificazione obbligatorio, filtri applicati in tre modi diversi (`?apply=auto|enter|none`),
filtri di gruppi e persone (menu e ricerca sul server), pulsanti *Open* e *Find by ID…*.
Scarica ExtJS una volta:

```bash
mkdir -p bookmarklet/test/vendor && cd bookmarklet/test/vendor && npm pack extjs-gpl@6.2.0 && tar -xzf extjs-gpl-6.2.0.tgz package/build/ext-all.js package/build/classic/theme-triton/resources && rm extjs-gpl-6.2.0.tgz
```

Poi avvia il finto portale (<http://127.0.0.1:8770/HDAPortal/>) e la prova:

```bash
python -m uvicorn bookmarklet.test.fake_hdaportal:app --port 8770
```

```bash
node bookmarklet/test/e2e.js
```

## Funzionalità di ricerca

- Testo cercato dal portale (campo *Search*), "l'oggetto contiene", classificazione e
  classificazione cliente (testo).
- Data di apertura con preimpostazioni (ultimi 30 giorni, 3/6/12 mesi, anno corrente, anno
  scorso, 2 o 5 anni) e data di ultimo aggiornamento.
- Stato: tutti, aperti, chiusi e risolti, scelti a mano o come nella pagina; priorità.
- Gruppi e persone: assegnato a (persona o gruppo), gruppo proprietario, modificato da,
  responsabile.
- Sempre su tutti i ticket (elenco All tickets); conteggio per anno con ricerca nel singolo anno.
- Sui risultati ricevuti: parole da escludere e verifica che compaiano tutte le parole.
- Quando il portale ha più ticket del massimo compare un avviso con il totale e un pulsante per
  caricare i successivi.

**Sui risultati**: filtro istantaneo (parole, `-esclusioni`, `"frasi"`), faccette per stato,
priorità, gruppo, assegnatario, responsabile, modificato da, servizio, sede, anno, mese ed
etichette, ordinamento per data di
apertura o di aggiornamento, ID, oggetto o stato, raggruppamento, selezione multipla,
esportazione CSV (Excel) e JSON, copia degli ID, tutte le colonne della griglia per ogni ticket,
apertura del ticket nel portale.

**Personale**: preferiti con note ed etichette, ricerche salvate, cronologia.

## Applicazione web (server)

> Questa versione interroga l'indice Solr della **vecchia** Area Riservata ("Ricerca rapida"),
> che non contiene i ticket più recenti; non è ancora stata adattata al nuovo portale. Per il
> portale ticket usa il segnalibro.

Utile per installarla una volta su un server interno e usarla da più postazioni.
Requisiti: Python 3.11 o successivo.

```bash
python -m venv .venv
```

```bash
source .venv/bin/activate
```

```bash
pip install -r requirements.txt
```

```bash
cp .env.example .env
```

```bash
python run.py
```

Apri <http://127.0.0.1:8000>. Per provare senza credenziali scegli **Demo**:
nome utente qualsiasi, password `demo` (40.000 ticket sintetici, stesso formato e
stesso limite di 210 risultati di Zucchetti).

Con Docker:

```bash
docker compose up -d --build
```

In produzione: solo dietro **HTTPS** con `COOKIE_SECURE=1`, `CONNECTORS=zucchetti`
per togliere la demo, `ALLOWED_USERS` per limitare gli utenti. Il server conserva
in memoria le sessioni Zucchetti degli utenti, quindi va installato su una macchina
fidata. Con nginx disattiva il buffering per `/api/search` (`proxy_buffering off;`).

### Variabili d'ambiente

| Variabile | Predefinito | Descrizione |
|---|---|---|
| `CONNECTORS` | `zucchetti,demo` | Connettori disponibili nella pagina di accesso |
| `COOKIE_SECURE` | `0` | `1` per inviare il cookie di sessione solo via HTTPS |
| `SESSION_IDLE_MINUTES` | `480` | Minuti di inattività prima della scadenza della sessione |
| `ALLOWED_USERS` | *(vuoto)* | Elenco di utenti ammessi (vuoto = tutti) |
| `APP_DIAGNOSTICS` | `0` | Mostra la pagina **Diagnostica** (serve per la configurazione iniziale) |
| `DATA_DIR` | `./data` | Database SQLite e modello di richiesta importato |
| `ZUCCHETTI_CONFIG` | `config/zucchetti.json` | File di configurazione del connettore |
| `CACHE_TTL_SECONDS` | `600` | Cache dei risultati per utente |
| `LOGIN_ATTEMPTS_PER_10MIN` | `10` | Tentativi di accesso consentiti per IP |
| `DEMO_SIZE`, `DEMO_LATENCY_MS` | `40000`, `250` | Dimensione e latenza simulata della demo |
| `HOST`, `PORT` | `127.0.0.1`, `8000` | Indirizzo di ascolto |

### Configurare il connettore Zucchetti

Tutto si trova in [`config/zucchetti.json`](config/zucchetti.json).

- **Accesso**: il login legge la pagina di ingresso, trova il form con il campo
  password (SitePainter `servlet/cp_login` o una pagina SSO), lo compila e verifica
  l'accesso aprendo `jsp/gspv_psearch.jsp`. Con secondo fattore o captcha si usa la
  scheda **Sessione del browser** incollando il cookie.
- **Chiamata di ricerca**: con `APP_DIAGNOSTICS=1`, nella pagina **Diagnostica**
  si incolla la richiesta `spsl_fquery_mc` copiata dal browser con *Copy as cURL
  (bash)*: endpoint, metodo e parametri esatti vengono salvati in
  `data/request_template.json` (i cookie vengono scartati).
- **Campi dei filtri**: finché un campo ha `"solr": null` il filtro resta
  disattivato. I nomi si ricavano dai *dati tecnici* del segnalibro o dal
  parametro `pKeyword` di una ricerca fatta sul sito con un filtro impostato.
- **Link "Apri"**: se `url1` non è un URL, imposta `parse.ticket_url_template`.

### Sicurezza

- La password viene inoltrata solo a Zucchetti durante il login e non viene mai
  salvata né registrata; il server tiene in memoria solo i cookie della sessione
  Zucchetti, che scadono con l'inattività.
- Cookie `HttpOnly` e `SameSite=Strict`, intestazione anti-CSRF obbligatoria,
  controllo dell'origine, Content Security Policy restrittiva, limite ai tentativi
  di accesso; le celle CSV vengono neutralizzate contro l'iniezione di formule.

## Struttura

```
bookmarklet/
  src/ricerca-tkt.js    sorgente del segnalibro (un solo file, nessuna dipendenza)
  build.mjs             genera dist/ e installa.html
  installa.html         pagina con il pulsante da trascinare nei preferiti
  dist/                 segnalibro e codice per la console, già generati
  test/                 finto portale ticket (ExtJS) e prova completa nel browser
app/
  main.py               API FastAPI, sessioni, risultati in streaming (NDJSON)
  query.py              costruzione della query Solr e filtri locali
  search.py             una richiesta per ricerca, filtri locali, cache
  parser.py             interpretazione della risposta di spsl_fquery_mc
  store.py              SQLite: ricerche salvate, cronologia, preferiti
  curl_import.py        importazione della richiesta da "Copy as cURL"
  connectors/           Zucchetti (login SitePainter/SSO, m_cID) e demo
config/zucchetti.json   configurazione del connettore
static/                 interfaccia dell'applicazione web
tests/                  test automatici, compreso un finto server SitePainter
```

## Test

```bash
pip install -r requirements-dev.txt
```

```bash
python -m pytest
```
