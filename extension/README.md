# Ricerca TKT — Estensione Chrome / Edge (v5.0)

Applicazione dedicata in una scheda del browser per cercare e leggere **ticket**, **Knowledge Base** e **FAQ** di **HDA TOUCH** (`https://zucchetti.support/HDAPortal/`) — più Vecchio Cruscotto e Storico dell'Area Riservata — con un'interfaccia Helpdesk scura (blu notte / nero con accenti blu) senza toccare i componenti ExtJS della pagina.

Parla in **sola lettura** con gli stessi servizi dati che usa l'interfaccia di Touch (`WSCView/ListData`, `WSCView/List`, `WSCView/HTMLPreview`, `WSC/Projection`, `WSCView/GetStaticList`, `WSCView/GetStaticSimpleList`, `WSCView/TreeData`), usando la sessione già aperta nel browser. Non chiama mai `Detail`, `DoLockObject`, `Save`, `Delete` o `Close`: leggere un ticket, un articolo KB o una FAQ qui **non blocca mai il record** in Touch per gli altri operatori.

## Installazione (Chrome o Edge, nessuna compilazione)

1. Scarica o aggiorna questa cartella sul PC.
2. Apri `chrome://extensions` (oppure `edge://extensions` su Edge).
3. Attiva **Modalità sviluppatore** (in alto a destra su Chrome, a sinistra su Edge).
4. Premi **Carica estensione non pacchettizzata** (*Load unpacked*) e seleziona la cartella `extension`.
5. Fissa l'icona **Ricerca TKT** nella barra del browser (oppure usa <kbd>Alt</kbd>+<kbd>Maiusc</kbd>+<kbd>T</kbd>).

Dopo un aggiornamento del codice basta premere il pulsante **Ricarica** (↻) nella scheda dell'estensione su `chrome://extensions`.

## Uso

1. Apri `https://zucchetti.support/HDAPortal/` ed esegui l'accesso normalmente.
2. Clicca l'icona **Ricerca TKT**: si apre la scheda dell'applicazione con la barra di navigazione sinistra (**Fonti**), la colonna **Filtri** (aperta di default e richiudibile con il tasto **Filtri**), l'area **Risultati** con schede sottolineate (*Risultati · Archivio locale · Preferiti · Recenti*) e, a destra, il pannello **Attività recente** che lascia spazio al **Lettore** quando apri un elemento.
3. **Filtri (HDA Touch)**:
   - **Stato**: tre pulsanti chiari (**Aperti**, **In attesa**, **Chiusi**) più *Scegli i singoli stati* con tutti i 32 stati di Touch in italiano. Nessuno scelto = **tutti gli stati** (compresi i chiusi, che Touch di solito nasconde).
   - **Gruppi e persone**: *Gruppo di lavoro*, *Assegnato a* (operatore o gruppo, con scelta rapida **Solo i miei**), *Responsabile*, *Ultima modifica di*, con suggerimenti immediati e scelta multipla a "gettoni".
   - **Cliente e prodotto**: *Cliente* (per ragione sociale o codice), *Prodotto*, *Classificazione cliente*.
   - **Date**: *Aperto (dal – al)* e *Ultimo aggiornamento (dal – al)* con scelte rapide (*7 giorni*, *30 giorni*, *12 mesi*, *Quest'anno*, *Anno scorso*).
   - **Testo, tipo e priorità**: barra principale (numero ticket o parole), *L'oggetto contiene*, *Tag*, *Tipo di ticket*, *Priorità*.
4. **Lettura del ticket**:
   - Un'unica **timeline ordinata**: *Richiesta iniziale* → *Messaggi* (colorati per **Cliente**, **Operatore**, **Nota interna**, **Sistema**) → *Soluzione*, senza il messaggio automatico di creazione che ripete la richiesta e con l'HTML ripulito (niente tag o entità `&quot;` a vista).
   - Le risposte email con lo storico citato sotto hanno il pulsante **Mostra il testo citato**.
   - I numeri di ticket citati nel testo (es. `tk 10500123`) sono cliccabili e aprono quel ticket direttamente nel lettore.
   - Barra strumenti della conversazione: mostra/nascondi **Note interne**, ordine **Dal più vecchio / Dal più recente**, **Cerca nel ticket** con evidenziazione immediata, **Copia** tutto il ticket come testo pulito, **Apri in Touch** (apre il dettaglio nella scheda di Touch).
5. **Cercare dentro il testo delle conversazioni (Archivio locale)**:
   - Ogni ticket che apri viene salvato automaticamente nell'archivio locale del browser (`IndexedDB`) con **tutta la conversazione**.
   - Con **Archivia** puoi salvare in blocco i ticket della ricerca corrente (2 alla volta con pausa, saltando quelli non modificati).
   - Nella scheda **Archivio locale** la ricerca trova le parole anche dentro tutti i messaggi e le note interne.

## Le fonti: HDA Touch, Vecchio Cruscotto, Storico, Knowledge Base, FAQ

Nella barra laterale sinistra ci sono cinque fonti, ognuna con il proprio colore distintivo e il conteggio dei risultati trovati. Lo stesso colore segna il bordo sinistro della scheda e il badge nel lettore, così si vede sempre da dove proviene ogni elemento.

| Fonte | Che cos'è | Come si cerca |
|---|---|---|
| **HDA Touch** (blu) | I ticket di HDA TOUCH | Parole, numero e tutti i filtri a sinistra |
| **Vecchio Cruscotto** (arancio) | La *Ricerca rapida* dell'Area Riservata (anni recenti) | Parole e numero dalla casella in alto, più i suoi filtri a sinistra: periodo, stato, gruppo e operatore che hanno in carico il ticket, cliente, gruppo e operatore che hanno partecipato. Si può cercare anche solo con i filtri |
| **Storico** (ciano) | La *Ricerca avanzata* dell'Area Riservata: tutti i ticket, anche prima del 2024 | Numero ticket, periodo (riferito all'ultimo aggiornamento o all'apertura), stato aperto/chiuso, codice cliente, gruppo, operatore. **Non cerca per parole** (nel portale i campi oggetto e testo sono disattivati) |
| **Knowledge Base** (verde) | Gli articoli Knowledge Base di **HDA TOUCH** (`KBArticles`), sostitutivi delle vecchie schede SKB dell'Area Riservata | Parole o codice KB (`KB4335Z`, `KB12051HR`) dalla barra in alto, tasto **Sfoglia tutti**, più tutti i filtri di Touch a sinistra (*Titolo*, *Codice*, *Stato*, *Tipo*, *Cartella*, *Argomento*, *Lingua*, *Prodotto*, *Versione prodotto*, *Data*, *Allegati*) |
| **FAQ** (azzurro) | Le **FAQ di HDA TOUCH** (`Faqs`), in una scheda completamente dedicata | La barra globale **non** cerca nelle FAQ. Nella scheda FAQ hai sia la **casella unificata** (*Domanda + Risposta*, più parole, singolare/plurale, ordinamento per attinenza), sia le **due caselle separate** *Domanda* e *Risposta* e i filtri di Touch a sinistra |

- **Numero ticket** nella casella in alto: si cerca in HDA Touch, Vecchio Cruscotto e Storico insieme. Il ticket si apre da solo e la fonte passa a quella che lo contiene. Un **codice KB** (es. `KB4335Z`) passa invece alla Knowledge Base e apre l'articolo.
- **Niente ricerche non richieste**: ogni fonte ticket/KB cerca solo quando c'è qualcosa da cercare (parole, codice/numero o un filtro). La scheda **FAQ** carica invece l'elenco aggiornato di HD Touch appena la apri, pronto per essere filtrato.
- **L'app si apre sempre vuota**: parole e filtri dell'ultima volta non vengono ricordati. Per ritrovare una ricerca usa *Salva ricerca* (HDA Touch). Restano invece l'ordinamento scelto, le impostazioni, i preferiti e i recenti.
- **Parole** nella casella in alto: si cercano in HDA Touch, Vecchio Cruscotto e Knowledge Base (mai nelle FAQ). La scheda Storico lo dice e propone i suoi filtri.
- **Ogni fonte ha i suoi filtri**: la colonna Filtri cambia automaticamente con la fonte attiva e vale solo per quella fonte. Cambiare un filtro rifà la ricerca solo lì e non cambia fonte.
- **Scheda Vecchio Cruscotto**: i filtri sono quelli della Ricerca rapida del portale. «Gruppo che ha partecipato» trova i ticket a cui un gruppo ha lavorato anche se ora li ha in carico un altro. Il periodo va a mesi interi e si riferisce all'ultimo aggiornamento o all'apertura. Il portale restituisce al massimo 210 ticket per ricerca (i più rilevanti): quando succede un avviso lo dice. Con un numero ticket nella casella i filtri non contano. *Esporta Excel* scarica i ticket in elenco.
- **Scheda Storico**: a sinistra compaiono i suoi filtri. Di partenza il periodo è «fino al 2023» (i ticket che il Vecchio Cruscotto non mostra più); con *Tutti gli anni* si cerca su tutto. Senza nessun filtro non parte nessuna ricerca.
- **Centro servizi**: Vecchio Cruscotto e Storico cercano solo tra i ticket del tuo centro (es. `PAOW`); i partner usano lo stesso cruscotto con un loro centro, e i loro ticket non devono comparire. L'app legge il centro dal modulo di ricerca del portale (lo stesso da cui lo prende il portale); di riserva lo ricava dai ticket del tuo gruppo di Touch (`G10663HR` → gruppo 10663), oppure lo si scrive in *Diagnostica → Impostazioni → Centro servizi dell'Area Riservata*. Cercando parole, i ticket di un altro centro vengono comunque scartati. Un numero ticket si cerca comunque anche fuori dal centro.
- **Nomi nel Vecchio Cruscotto**: la sua ricerca per parole riporta solo i codici di cliente, gruppo e operatore. L'app chiede i nomi allo Storico, un ticket alla volta partendo dall'alto dell'elenco (numero + giorno di apertura), e li scrive nelle righe man mano che arrivano; ogni nome trovato resta in memoria e non viene più richiesto.
- **Lettura di un ticket del Vecchio Cruscotto**: la conversazione si legge dalla scheda del ticket nell'Area Riservata, quindi ogni messaggio ha il nome di chi l'ha scritto, il destinatario, la data e la causale. Se la scheda non risponde entro qualche secondo si vede la conversazione ricostruita dal testo della ricerca.
- Nelle viste *Archivio locale*, *Preferiti* e *Recenti* ogni scheda porta il badge e il colore della propria fonte.

## Knowledge Base (HD Touch)

La fonte **Knowledge Base** interroga direttamente `ListData/KBArticles` di **HDA TOUCH**, sostituendo integralmente le vecchie schede SKB dell'Area Riservata. Basta quindi la sessione di HDA TOUCH (non serve più l'Area Riservata).

- **Ricerca**: dalla barra in alto puoi cercare parole (l'app interroga in parallelo il testo completo `FullText` con varianti/asterisco e il `Titolo`, unendo e ordinando per attinenza) oppure un codice articolo (`KB4335Z`, `KB12051HR`). Con **Sfoglia tutti** o scegliendo un filtro a sinistra puoi esplorare tutti gli articoli senza testo.
- **Filtri di Touch a sinistra**: *Titolo contiene*, *Codice*, *Stato* (**Pubblicato**, **Pubblicato Internamente**, **Non Pubblicato**, **Archived**), *Tipo* (**Informazione**, **Errore**), *Cartella* (albero `CatalogFolders`), *Argomento* (`CatalogItems`), *Prodotto* (`Services`), *Versione Prodotto*, *Lingua*, *Data creazione (dal – al)* e *Allegati* (**Sì** / **No**).
- **Lettura in sola lettura**: aprendo una scheda l'app legge il contenuto HTML completo tramite `WSCView/HTMLPreview` e l'elenco allegati tramite `ListData/Attachments` (`AttachmentPreview`), senza bloccare l'articolo. Gli allegati si aprono in anteprima direttamente nel lettore e **Apri in Touch** apre l'articolo (`KBArticle` / `CommKB`) nella scheda di Touch.
- Le schede lette finiscono nell'archivio locale, nei *Recenti*, in *Attività recente* e si possono aggiungere ai *Preferiti*.

## FAQ (HD Touch)

La fonte **FAQ** interroga direttamente `ListData/Faqs` di **HDA TOUCH** con una ricerca isolata e dedicata:

- **Ricerca isolata dalla barra principale**: ciò che scrivi nella barra globale per ticket/KB **non** filtra le FAQ. Quando passi alla fonte **FAQ**, la barra in alto diventa automaticamente la **casella di ricerca unificata delle FAQ**.
- **Casella unificata (Domanda + Risposta)**: cerca contemporaneamente nella **Domanda** e nella **Risposta**, supportando **più parole**, **singolare/plurale italiano**, evidenziazione dei termini e **ordinamento per attinenza**. Per le risposte che superano i 500 caratteri troncati dall'elenco di Touch, l'app verifica automaticamente il testo integrale (`Projection`) così da non perdere corrispondenze.
- **Due caselle separate + filtri di Touch a sinistra**: nella colonna Filtri trovi anche le due caselle separate **Domanda contiene** e **Risposta contiene** (identiche al cruscotto di Touch), più tutti i filtri funzionanti di HD Touch: **Codice**, **Stato** (*Pubblicato*, *Pubblicato internamente*, *Non Pubblicato*), **Cartella**, **Elemento di catalogo**, **Importanza (min.)**, **Data creazione (dal – al)** e **Data cambio stato (da)**. *(I filtri Categoria e Tags di Touch sono esclusi volutamente perché non funzionanti nel portale).*
- **Lettura in sola lettura**: apre Domanda, Risposta HTML completa (`WSCView/HTMLPreview`), metadati (codice, stato, importanza, date di pubblicazione/visibilità), allegati in anteprima e tasto **Apri in Touch** (`Entity=Faq`).

## Più schede aperte insieme: «Nuova pagina»

Un ticket, un articolo della Knowledge Base o una FAQ si può aprire in una pagina del browser tutta sua, dove si vede solo il lettore. Le pagine restano aperte una accanto all'altra e il titolo di ognuna dice numero/codice e oggetto.

- **Dal lettore**: pulsante **Nuova pagina**.
- **Dall'elenco**: il pulsante con la freccia che compare a destra della scheda passandoci sopra, oppure **Ctrl+clic** (o clic con la rotella) sulla scheda: la pagina si apre dietro e nell'elenco non cambia niente.
- Nella pagina singola la **X** chiude la pagina; **Apri la ricerca**, in alto, mostra lì l'app intera. *Esc* non chiude la pagina.
- La pagina legge il contenuto dal portale per conto suo: serve la stessa sessione aperta (Touch o Area Riservata).

## Se non si collega a Touch

L'app prova prima a chiamare Touch direttamente. Se Touch risponde con un errore del suo collegamento interno (per esempio «An error occourred on the webservice underlying connection…» o «Si è verificato un errore durante il caricamento dei dati»), ripete la stessa richiesta dalla **scheda di HDA TOUCH aperta**, con i suoi cookie e lo stesso server, e da quel momento passa sempre da lì. In alto compare *Connesso a Touch (tramite scheda)*.

- Tieni aperta una scheda di HDA TOUCH con l'accesso fatto: tornando sull'app riprova da sola.
- Se l'errore arriva anche dalla scheda, il problema è della sessione di Touch: ricarica la pagina di Touch (se serve esci e rientra) e premi *Riprova*.
- La lingua delle richieste (`_pl`) è la stessa che usa la pagina di Touch (Impostazioni → *Lingua del portale* → *Automatica*).

## Ricerca per numero ticket (HDA TOUCH e Vecchio Cruscotto)

Scrivi il numero nella barra principale (vanno bene anche `#`, `tk`, `ticket n.` davanti):

| Scrivi | HDA TOUCH | Vecchio Cruscotto |
|---|---|---|
| `11943797` (8 cifre) | `11943797Z` e `11943797`, in parallelo | `NumTic:11943797` |
| `9876543` (7 cifre) | `9876543` (migrato) e `9876543Z` (nativo), in parallelo | `NumTic:9876543` |
| `9876543Z` (Z scritta) | solo `9876543Z` | non interrogato |

- I ticket di Touch **con la Z** e quelli del **Vecchio Cruscotto** con le stesse cifre sono ticket diversi: ognuno compare nella scheda della sua fonte e un avviso lo segnala. Un ticket di Touch **senza Z** (migrato) che c'è anche nel Vecchio Cruscotto compare in tutte e due le schede.
- Si apre da solo il ticket nella forma scritta (7 cifre senza Z → prima il ticket senza Z, poi quello di Touch con la Z); con la Z scritta, sempre quello di Touch.
- Cliccando una riga del Vecchio Cruscotto si legge quel ticket (non un ticket di Touch con le stesse cifre).
- Un numero ticket nella casella porta solo a quel ticket e **non tiene conto dei filtri a sinistra**: quando scegli un filtro (gruppo, stato, cliente…) il numero rimasto da una ricerca precedente si toglie da solo, e se scrivi un numero con dei filtri già scelti un avviso lo ricorda (*Togli il numero*).

## Gruppo di lavoro e testo nella casella

- **Gruppo di lavoro** è il *Gruppo owner* del ticket in Touch (es. `Paghe Infinity - Paghe Web P`). Per i ticket assegnati a un gruppo usa *Assegnato a*.
- Con delle parole nella casella di ricerca e un filtro scelto, si cercano le parole **solo nei ticket del filtro**: sopra l'elenco un avviso lo dice e con *Togli il testo* vedi tutti i ticket del gruppo.
- **Asterisco automatico in HDA Touch** (di partenza): le parole della casella in alto vanno a Touch con l'asterisco, come si fa a mano nel portale. «centro di costo» si cerca come `centr* di cost*`: valgono singolare, plurale e le parole che iniziano allo stesso modo. Sopra l'elenco si legge come è stata mandata la ricerca («Cercato come: …»).
  - L'app toglie la desinenza e mette l'asterisco, lasciando sempre almeno quattro lettere. Restano come sono le parole fino a tre lettere (*di*, *non*), i numeri e le sigle con cifre o segni (*730*, *L307*, *26.05.00*), le parole di servizio (*della*, *nelle*…) e le parole dove l'asterisco è già scritto.
  - In cima ai filtri di HDA Touch, **Parole della casella in alto** → *Esatte* spegne l'asterisco automatico (la scelta resta anche alle prossime aperture). L'asterisco scritto a mano vale sempre, anche nel Vecchio Cruscotto e nella Knowledge Base.
  - Con l'asterisco il numero di ticket è quello di Touch e *Mostra altri* carica le pagine successive. Le ricerche con l'asterisco sono più lente (nel portale una decina di secondi): se Touch supera il suo limite di 25 secondi l'app riprova sugli ultimi 24 mesi e lo dice.
- **Più parole in HDA Touch, con «Esatte»**: l'app cerca come il portale. Tutto il testo della casella va a Touch in una sola ricerca, ed è Touch a trovare i ticket che contengono tutte le parole (in oggetto, richiesta, soluzione o messaggi). Il numero di ticket è quello del portale e *Mostra altri* carica le pagine successive. Unica differenza: l'app non applica i filtri fissi della vista di Touch su stati e tipi, quindi può trovarne qualcuno in più.
  - **Ricerca estesa** (pulsante nell'avviso sopra l'elenco): Touch cerca le parole scritte così, quindi «maggiorazione» non trova «maggiorazioni». La ricerca estesa chiede a Touch i ticket con la parola più lunga e controlla gli altri uno per uno nell'app, contando anche singolari e plurali. È lenta (150 ticket alla volta, fino a 1.500 per clic): serve quando non si vuole perdere niente.
  - Con una "frase tra virgolette" resta il modo dell'app: parola o frase più lunga al portale, il resto verificato nell'app.
- **Più parole nel Vecchio Cruscotto**: le parole si chiedono tutte al portale e i ticket che trova restano tutti in elenco. Rispetto alla ricerca «Tutte le parole» del portale l'app trova di più: il portale cerca la parola esatta (con «maggiorazioni» non trova «maggiorazione») e vuole tutte le parole nello stesso campo; l'app cerca anche singolare e plurale e accetta una parola nell'oggetto e l'altra nel testo. Il limite di 210 ticket per ricerca è del portale: *Cerca tutti* lo supera.

## Trovare il ticket giusto: attinenza, varianti, filtro in elenco

Tutto calcolato nel browser: nessun testo dei ticket esce dal PC.

- **Ordina per «Attinenza»** (ordinamento di partenza, si cambia dal menu accanto al numero di ticket): in alto i ticket più vicini alle parole cercate. L'ordine è a fasce, dalla più alta:
  1. tutte le parole vicine nel testo;
  2. tutte le parole vicine nell'oggetto;
  3. tutte le parole ma lontane tra loro (prima nel testo, poi nell'oggetto, poi divise tra oggetto e testo);
  4. alcune parole nel testo;
  5. alcune parole nell'oggetto e nel testo;
  6. alcune parole solo nell'oggetto.

  «Vicine» vuol dire entro poche parole l'una dall'altra, nello stesso messaggio (due parole: entro sei). Dentro una fascia vengono prima le parole più strette o scritte come frase, la parola esatta rispetto alla variante e chi ha più parole; a parità, il ticket più recente. Con una parola sola: prima chi l'ha nel testo, poi chi l'ha solo nell'oggetto. Senza parole nella casella l'ordine è dal più recente.
  - «Testo» è la richiesta più i messaggi. Nel Vecchio Cruscotto ci sono tutti i messaggi; in HDA Touch c'è la richiesta dei ticket caricati (i primi 150; con *Mostra altri* se ne aggiungono).
- **Singolare e plurale**: «cedolino» vale anche per «cedolini», «premio» per «premi». Le varianti contano nella verifica «tutte le parole», nell'attinenza e sono evidenziate in giallo. Una "frase tra virgolette" si cerca invece così com'è scritta.
- **Estratto**: sotto l'oggetto si vede il punto del testo dove compaiono le parole cercate, non l'inizio del messaggio.
- **Filtra in elenco** (casella sopra i risultati): restringe i ticket già trovati mentre scrivi, senza interrogare il portale. Tutte le parole devono comparire; `-parola` toglie i ticket che la contengono. Cerca anche in numero, cliente, gruppo, operatore e stato. *Esc* la svuota; si azzera a ogni nuova ricerca dalla casella in alto.
- **Vecchio Cruscotto oltre i 210 ticket**: quando il portale tronca i risultati, l'avviso offre *Cerca tutti*. L'app ripete la ricerca divisa per periodi (anni, poi metà, fino al singolo mese) e riunisce i ticket. Si ferma a 1.500 ticket o 45 richieste, e dice se un mese è rimasto troncato.

## Velocità

- I risultati compaiono **man mano che arrivano**: prima l'oggetto dei ticket di Touch e il Vecchio Cruscotto, poi la ricerca dentro i messaggi di Touch (la più lenta). Sotto l'elenco si vede dove sta ancora cercando.
- Le ricerche fatte negli ultimi 2 minuti tornano **subito dalla memoria**; il pulsante ↻ (Aggiorna) le rifà sempre sul portale.
- Mentre scrivi si cerca dopo una breve pausa e da 3 caratteri (o un numero ticket completo); <kbd>Invio</kbd> cerca subito.
- Quando la ricerca nei messaggi di Touch (che copre anche l'oggetto) ha risposto, quella sull'oggetto non si aspetta più: su tutto lo storico può arrivare al timeout di 25 s.
- **Senza parole né filtri HDA Touch non carica niente**: all'avvio, o svuotando casella e filtri, l'elenco resta vuoto e al portale non si chiede nessun elenco. Per vedere i ticket aperti basta scegliere lo stato «Aperti» (o il proprio gruppo) a sinistra.
- Aprendo un ticket dall'elenco, dati, conversazione e allegati si caricano insieme.
- I filtri di HDA Touch non valgono nel Vecchio Cruscotto, che ha i suoi. Nei suoi filtri i gruppi si scelgono per nome: il gruppo di Touch `G10663HR` è il gruppo `10663` dell'Area Riservata.

## Auto-apprendimento dei filtri e Diagnostica

Alcuni filtri di Touch (formato delle date, ricerca nel testo completo, oggetto, tag) non compaiono nel tracciato iniziale e vengono appresi automaticamente:

- **Come insegnare un filtro all'estensione**: apri la scheda di Touch, usa una volta quel filtro nell'elenco ticket (*All tickets*) e l'estensione registra da sola proprietà, operatore e formato del valore (`appreso da Touch`). Inoltre nella sezione **Filtri usati in Touch** puoi riapplicare con un clic le ultime ricerche fatte nel portale.
- **Diagnostica**: il pulsante **Diagnostica** in alto a destra prova in sola lettura tutti i servizi del portale e genera con **Copia rapporto** un JSON **senza dati personali** (solo esiti, mappa colonne `c0…cN`, definizioni dei filtri e forma dei valori).

## Sviluppo e test

```bash
# Test automatici delle librerie (Node 20+)
node --test extension/test/*.test.mjs

# Portale finto con dati sintetici per provare l'interfaccia fuori da Touch
python3 extension/dev/mock_server.py 8765
# → http://localhost:8765/app/index.html
```
