# Ricerca TKT

Motore di ricerca avanzato per i ticket dell'**Area Riservata Zucchetti**, con
accesso tramite le proprie credenziali.

I ticket sono più di un milione, quindi non vengono scaricati: l'applicazione
**interroga in tempo reale** lo stesso indice Solr usato dalla pagina "Ricerca
rapida" di Zucchetti. Aggiunge una costruzione delle query più potente, la
possibilità di superare il limite di 210 risultati, filtri e raggruppamenti sui
risultati, esportazione, preferiti con note e ricerche salvate.

> Stato: il connettore verso Zucchetti è stato ricostruito dall'outerHTML della
> pagina di ricerca e testato contro un finto server con lo stesso protocollo, ma
> **non ancora contro il sito reale**, che non era raggiungibile durante lo sviluppo.
> La modalità **Demo** funziona subito, con dati sintetici. Per completare la
> configurazione vedi [Configurare il connettore](#configurare-il-connettore-zucchetti).

## Come funziona

```
Browser ──► Ricerca TKT (questo server) ──► www.zucchetti.it/areariservata
            · login con le tue credenziali      servlet/spsl_fquery_mc  (routine Solr)
            · conserva solo il cookie di        pKeyword = query Solr
              sessione Zucchetti, in memoria    pCore = TICKET
            · costruisce le query Solr
            · ricerca estesa, unione e filtri
```

Dall'outerHTML della pagina di ricerca risulta che:

- la scheda **Risultati** è il portlet `spsl_wsolrresultsgrid`, che chiama la
  routine `spsl_fquery_mc` (`splResults.Link()`) con i parametri `pKeyword`,
  `pArea`, `pCore`, `pLangs`, `cs_SITE` e il codice di sicurezza `m_cID`;
- la risposta è un JSON con `fields`, `data`, `facet`, `maxResults`, `errors`;
- il titolo di ogni risultato ha la forma `[#8900042] [PAGHEW] [21-04-2026] oggetto`,
  con le parole trovate evidenziate da `<span solrfound="true">`;
- Zucchetti restituisce al massimo `maxResults` documenti ("Sono visualizzati i
  210 risultati più rilevanti").

## Funzionalità

**Ricerca**
- Modalità *tutte le parole*, *almeno una*, *frase esatta* (con distanza massima tra
  le parole) e **sintassi Solr libera** (`AND OR NOT ( ) "frase"~N parola* parola~ campo:valore`).
- Parole da escludere, frase obbligatoria, corrispondenza parziale (prefisso),
  tolleranza agli errori di battitura, "Cerca in" oggetto/testo.
- Periodo con preimpostazioni (ultimi 30 giorni, anno corrente…), numeri di
  ticket (elenchi e intervalli), prodotti da includere o escludere.
- I filtri della schermata originale (Stato, Stato base, Priorità, Tipologia,
  Gruppo, Operatore, Azienda, Persona, Operatore/Gruppo partecipante,
  Classificazione, Argomento, Centro servizi), con più valori, esclusioni (`-valore`)
  e caratteri jolly (`*`). Si attivano dopo averli mappati sui campi Solr.
- Anteprima della query Solr generata, modificabile a mano.
- `#8900042` nella barra di ricerca cerca direttamente quel ticket.

**Ricerca estesa (oltre i 210 risultati)**
- Se una ricerca arriva al limite, il periodo viene diviso in finestre
  (anno → mese → settimana → giorno). Una finestra ancora al limite viene divisa
  di nuovo; a livello di giorno si può proseguire **per esclusione** (la query
  viene ripetuta escludendo i numeri già trovati).
- I risultati arrivano progressivamente, senza duplicati, con avanzamento,
  pulsante di interruzione e un tetto di richieste configurabile (protegge il
  server Zucchetti).
- Senza campi mappati il periodo viene filtrato cercando la data scritta nel
  titolo (`"04-2026"`, `"21-04-2026"`). I risultati vengono poi verificati in
  locale, quindi le finestre non introducono falsi positivi.

**Risultati**
- Filtro istantaneo nei risultati (parole, `-esclusioni`, `"frasi"`).
- Faccette per prodotto, anno, mese ed etichette, con conteggi.
- Ordinamento per rilevanza, data, numero o oggetto; raggruppamento per
  prodotto, mese o anno; paginazione.
- Selezione multipla ed esportazione in CSV (compatibile con Excel), JSON,
  elenco dei numeri o elenco testuale.
- Link diretto al ticket su Zucchetti, che si apre nella sessione del tuo browser.

**Personale**
- Preferiti con note ed etichette, ricerche salvate e cronologia, conservati per
  utente in un database SQLite locale.
- Link condivisibili: la ricerca è codificata nell'URL (`#s=…`).
- Scorciatoie: `/` per cercare, `Ctrl+Invio` per la ricerca estesa, `Esc` per interrompere.

## Avvio rapido

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
nome utente qualsiasi, password `demo`. La demo genera 40.000 ticket sintetici con
lo stesso limite di 210 risultati e lo stesso formato di risposta di Zucchetti.

### Con Docker

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

### In produzione

- Pubblica l'applicazione solo dietro **HTTPS**, ad esempio con un reverse proxy
  nginx o Caddy, e imposta `COOKIE_SECURE=1`.
- Togli la demo: `CONNECTORS=zucchetti`.
- Con `ALLOWED_USERS` limiti l'accesso a determinati utenti Zucchetti.
- Il server conserva in memoria le sessioni Zucchetti degli utenti: installalo su
  una macchina fidata.
- Se usi nginx, disattiva il buffering per `/api/search` (`proxy_buffering off;`)
  così i risultati arrivano in modo progressivo.

## Variabili d'ambiente

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

## Configurare il connettore Zucchetti

Tutto si trova in [`config/zucchetti.json`](config/zucchetti.json).

### 1. Accesso

Il login legge la pagina di ingresso, trova il form con il campo password (quello
standard di SitePainter `servlet/cp_login`, ma anche eventuali pagine SSO), lo
compila e verifica l'accesso aprendo `jsp/gspv_psearch.jsp`.

Se l'accesso richiede un secondo fattore o un captcha, usa la scheda **Sessione
del browser** nella pagina di accesso: accedi a Zucchetti nel browser e incolla il
valore dell'intestazione `Cookie` (F12 → Rete → una richiesta verso zucchetti.it).

### 2. Chiamata di ricerca: importala da cURL

1. Avvia con `APP_DIAGNOSTICS=1` e accedi con il connettore Zucchetti.
2. Sul sito Zucchetti, con gli strumenti per sviluppatori aperti (F12 → Rete),
   cerca una parola semplice, ad esempio `detassazione`.
3. Fai clic destro sulla richiesta `spsl_fquery_mc` e scegli **Copy → Copy as cURL (bash)**.
4. In **Diagnostica** incolla il comando, indica la parola cercata e premi
   **Analizza e salva**. Endpoint, metodo e parametri esatti vengono salvati in
   `data/request_template.json`; i cookie vengono scartati.
5. Con **Prova una query** controlla la risposta grezza e come viene interpretata.

### 3. Mappare i campi dei filtri

Finché un campo ha `"solr": null` il relativo filtro resta disattivato
nell'interfaccia. Per conoscere i nomi dei campi Solr (stato, priorità, operatore,
data…):

- sul sito Zucchetti imposta un filtro (ad esempio *Stato tickets*), premi *Cerca* e
  guarda il parametro `pKeyword` della richiesta `spsl_fquery_mc`: conterrà
  qualcosa come `NOMECAMPO:"valore"`;
- oppure inviami l'outerHTML del contenuto della scheda **Filtri**, cioè l'iframe
  `gspv_winf_search`, che non è incluso nel file ricevuto: contiene la logica che
  costruisce la query.

Poi imposta il nome in `fields.<chiave>.solr`. Per numero ticket, prodotto e
data puoi passare la relativa strategia (`strategies.number`, `.product`, `.date`)
da `term`/`phrase` a `field`, così da filtrare direttamente in Solr.

### Cosa resta da verificare sul sito reale

- Metodo e parametri esatti di `spsl_fquery_mc` (risolto dal punto 2).
- Se `m_cID` cambia per sessione: viene letto automaticamente dal portlet
  `jsp/spsl_wsolrresultsgrid_portlet.jsp`, altrimenti si usa quello configurato.
- Il significato di `pArea` (forse il centro servizi) e i codici di `pLangs`:
  sono modificabili in *Opzioni avanzate → Indice di ricerca*.
- Il formato di `url1`, che fornisce il link "Apri" del ticket. Se non è un URL,
  imposta `parse.ticket_url_template` (ad esempio
  `https://www.zucchetti.it/areariservata/jsp/…?id={id}`).

## Uso responsabile

L'applicazione usa le credenziali dell'utente e lo stesso servizio della pagina di
ricerca, senza copiare l'archivio. La ricerca estesa può comunque generare
decine di richieste: concorrenza (`search.max_concurrency`), intervallo minimo tra
le richieste (`search.min_interval_ms`) e tetto per ricerca
(`extended.max_requests_hard_limit`) sono volutamente prudenti. Prima di usarla
in modo esteso verifica che l'accesso automatizzato sia consentito dalle
condizioni d'uso dell'Area Riservata.

## Sicurezza

- La password viene inoltrata solo a Zucchetti durante il login e non viene mai
  salvata né registrata; il server tiene in memoria solo i cookie della sessione
  Zucchetti, che scadono con l'inattività.
- Cookie di sessione `HttpOnly` e `SameSite=Strict`, intestazione anti-CSRF
  obbligatoria sulle chiamate di modifica, controllo dell'origine.
- Content Security Policy restrittiva (nessuno script inline); i risultati sono
  resi come testo, quindi l'HTML restituito da Zucchetti non viene mai iniettato
  nella pagina.
- Limite ai tentativi di accesso per IP; le celle CSV vengono neutralizzate contro
  l'iniezione di formule in Excel.

## Struttura

```
app/
  main.py               API FastAPI, sessioni, streaming dei risultati (NDJSON)
  query.py              costruzione della query Solr e filtri locali
  search.py             ricerca estesa: finestre temporali, esclusione, unione, cache
  parser.py             interpretazione della risposta di spsl_fquery_mc
  store.py              SQLite: ricerche salvate, cronologia, preferiti
  curl_import.py        importazione della richiesta da "Copy as cURL"
  connectors/
    zucchetti.py        login SitePainter/SSO, lettura m_cID, chiamata alla routine
    demo.py, demo_engine.py   archivio sintetico con un mini-motore Lucene
config/zucchetti.json   configurazione del connettore
static/                 interfaccia (HTML/CSS/JS, nessuna dipendenza esterna)
tests/                  test automatici, compreso un finto server SitePainter
```

## Test

```bash
pip install -r requirements-dev.txt
```

```bash
python -m pytest
```
