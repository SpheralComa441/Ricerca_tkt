# Ricerca TKT

Motore di ricerca avanzato per i ticket dell'**Area Riservata Zucchetti**.

I ticket sono più di un milione, quindi non vengono scaricati: ogni ricerca
interroga in tempo reale lo stesso indice Solr usato dalla pagina "Ricerca
rapida" di Zucchetti, **con una sola richiesta e con il limite di risultati di
Zucchetti** (210, i più rilevanti). Sopra c'è una costruzione delle query più
potente, con filtri, faccette, ordinamenti e raggruppamenti sui risultati,
esportazione, preferiti con note e ricerche salvate.

Esistono due versioni con le stesse funzioni di ricerca:

| | **Segnalibro** (consigliata per provare) | **Applicazione web** |
|---|---|---|
| Installazione | nessuna: un segnalibro nel browser | server con Python 3.11+ o Docker |
| Accesso | la sessione già aperta nell'Area Riservata | credenziali Zucchetti o cookie di sessione |
| Dati personali | nel browser (esportabili) | database SQLite sul server |
| Cartella | [`bookmarklet/`](bookmarklet/) | [`app/`](app/), [`static/`](static/) |

## Segnalibro: provalo subito

1. Scarica [`bookmarklet/installa.html`](bookmarklet/installa.html) (su GitHub:
   apri il file → pulsante *Download raw file*) e aprilo con Chrome o Edge.
2. Trascina il pulsante **Ricerca TKT** nella barra dei preferiti
   (<kbd>Ctrl</kbd>+<kbd>Maiusc</kbd>+<kbd>B</kbd> per mostrarla).
3. Accedi all'Area Riservata Zucchetti, apri la pagina **Ricerca rapida** e
   clicca il segnalibro: il motore di ricerca si apre sopra la pagina.
   <kbd>Esc</kbd> lo chiude, un altro clic sul segnalibro lo riapre.

In alternativa si può incollare il contenuto di
[`bookmarklet/dist/ricerca-tkt.min.js`](bookmarklet/dist/ricerca-tkt.min.js)
nella console del browser (F12 → Console) sulla pagina Zucchetti.

### Come funziona

Il segnalibro viene eseguito dentro la pagina Zucchetti, quindi usa la sessione
dell'utente e non deve gestire password o cookie. Ogni ricerca è una richiesta
alla routine `servlet/spsl_fquery_mc` nello stesso formato della scheda Filtri
della pagina, osservato sul sito reale:

```
pKeyword = IdCenSer:PAOW AND ((IdMeseM:9 AND IdAnnoM:2026) OR ...) AND (Testi:(…) OR Oggetto:(…))
pArea = TICKOPEXXX   pCore = (vuoto)   pLangs = ITA   cs_SITE = (vuoto)   m_cID = …
```

- testo cercato nei campi `Testi` e `Oggetto`, centro servizi in `IdCenSer`,
  periodo per mese e anno (`IdMeseM`/`IdAnnoM`, data di ultimo aggiornamento);
- la richiesta parte, in ordine di preferenza, ripetendo quella osservata dalla
  pagina, dal componente dei risultati (`spsl_wsolrresultsgrid`) o direttamente
  con il codice `m_cID` del portlet; se Zucchetti risponde con un errore se ne fa
  una sola altra con i parametri dell'ultima ricerca della pagina;
- le funzioni native del browser vengono prese da un riquadro nascosto, perché
  la pagina ne ridefinisce alcune (`controls.js` sostituisce `Set`).

**Filtri imparati dalla pagina.** I nomi dei campi Solr di Stato, Priorità,
Tipologia, Gruppo, Operatore, Prodotto, Numero ticket… non sono documentati. Il
segnalibro li impara da solo: quando la pagina fa una ricerca (anche prima di
aprire il segnalibro), confronta i valori scelti nel modulo Filtri
(`w_StatoDett = CLOSE`, …) con la query inviata e memorizza il campo. Dal modulo
Filtri prende anche gli elenchi dei valori (stati, priorità, gruppi, centri
servizi), che diventano menu a tendina. Finché un filtro non è stato imparato
compare come "da imparare"; si può anche impostare a mano in Impostazioni.

Il pannello è isolato in uno *shadow DOM*: non modifica la pagina Zucchetti e non
ne eredita gli stili; la pagina sotto resta inattiva finché il pannello è aperto.
I risultati sono resi come testo, quindi l'HTML restituito dal server non viene
mai iniettato.

In **Impostazioni** si trovano lo stato della connessione con i filtri attivi e
da imparare, la mappatura dei campi, **Copia/Scarica dati tecnici** (richieste
osservate senza cookie, un esempio di risposta, il modulo Filtri e i suoi script:
contengono alcuni risultati di esempio, quindi controllali prima di condividerli)
ed esportazione/importazione dei dati personali.

### Sviluppo del segnalibro

Il sorgente è [`bookmarklet/src/ricerca-tkt.js`](bookmarklet/src/ricerca-tkt.js).
Dopo una modifica rigenera `dist/` e `installa.html` (serve Node.js ed esbuild):

```bash
cd bookmarklet && npm i --no-save esbuild@0.24.0 && node build.mjs
```

Prova completa con un finto sito che riproduce la pagina reale (ricerca veloce,
portlet dei risultati caricato dopo la prima ricerca, modulo Filtri, routine con
area obbligatoria, funzioni native ridefinite):

```bash
python -m uvicorn bookmarklet.test.fake_zucchetti:app --port 8770
```

```bash
node bookmarklet/test/e2e.js
```

## Funzionalità di ricerca

- Modalità *tutte le parole*, *almeno una*, *frase esatta* (con distanza massima
  tra le parole) e **sintassi Solr libera** (`AND OR NOT ( ) "frase"~N parola* parola~ campo:valore`).
- Parole da escludere, frase obbligatoria, corrispondenza parziale (prefisso),
  tolleranza agli errori di battitura, "Cerca in" oggetto/testo.
- Periodo con preimpostazioni, numeri di ticket (elenchi e intervalli), prodotti
  da includere o escludere. Il periodo viene filtrato cercando la data scritta nel
  titolo dei risultati (`"04-2026"`, `"21-04-2026"`) e i risultati vengono poi
  verificati in locale.
- I filtri della schermata originale (Stato, Stato base, Priorità, Tipologia,
  Gruppo, Operatore, Azienda, Persona, Operatore/Gruppo partecipante,
  Classificazione, Argomento, Centro servizi), con più valori, esclusioni
  (`-valore`) e caratteri jolly (`*`), attivi dopo averli mappati sui campi Solr.
- Anteprima della query Solr generata, modificabile a mano; `#8900042` cerca
  direttamente quel ticket.
- Quando Zucchetti restituisce il massimo dei risultati compare un avviso che
  suggerisce di restringere la ricerca.

**Sui risultati**: filtro istantaneo (parole, `-esclusioni`, `"frasi"`),
faccette per prodotto, anno, mese ed etichette, ordinamento per rilevanza, data,
numero o oggetto, raggruppamento per prodotto, mese o anno, selezione multipla,
esportazione CSV (Excel) e JSON, copia dei numeri, apertura del ticket su Zucchetti.

**Personale**: preferiti con note ed etichette, ricerche salvate, cronologia.

## Applicazione web (server)

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
  test/                 finto sito Zucchetti e prova completa nel browser
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
