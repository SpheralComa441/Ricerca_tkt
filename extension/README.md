# Ricerca TKT — Estensione Chrome / Edge (v4.2)

Applicazione dedicata in una scheda del browser per cercare e leggere i ticket di **HDA TOUCH** (`https://zucchetti.support/HDAPortal/`) senza toccare i componenti ExtJS della pagina.

Parla in **sola lettura** con gli stessi servizi dati che usa l'interfaccia di Touch (`WSCView/ListData`, `WSCView/List`, `WSC/Projection`, `WSCView/GetStaticList`), usando la sessione già aperta nel browser. Non chiama mai `Detail`, `DoLockObject`, `Save`, `Delete` o `Close`: leggere un ticket qui **non lo blocca** in Touch per gli altri operatori.

## Installazione (Chrome o Edge, nessuna compilazione)

1. Scarica o aggiorna questa cartella sul PC.
2. Apri `chrome://extensions` (oppure `edge://extensions` su Edge).
3. Attiva **Modalità sviluppatore** (in alto a destra su Chrome, a sinistra su Edge).
4. Premi **Carica estensione non pacchettizzata** (*Load unpacked*) e seleziona la cartella `extension`.
5. Fissa l'icona **Ricerca TKT** nella barra del browser (oppure usa <kbd>Alt</kbd>+<kbd>Maiusc</kbd>+<kbd>T</kbd>).

Dopo un aggiornamento del codice basta premere il pulsante **Ricarica** (↻) nella scheda dell'estensione su `chrome://extensions`.

## Uso

1. Apri `https://zucchetti.support/HDAPortal/` ed esegui l'accesso normalmente.
2. Clicca l'icona **Ricerca TKT**: si apre la scheda dell'applicazione con tre colonne (**Filtri** · **Risultati** · **Lettore del ticket**).
3. **Filtri**:
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
   - Con **Archivia risultati** puoi salvare in blocco i ticket della ricerca corrente (2 alla volta con pausa, saltando quelli non modificati).
   - Nella scheda **Archivio locale** la ricerca trova le parole anche dentro tutti i messaggi e le note interne.

## Le tre fonti: HDA Touch, Vecchio Cruscotto, Storico

Sopra l'elenco ci sono tre schede, ognuna con il suo colore e il numero di ticket trovati. Lo stesso colore segna la riga del ticket (striscia a sinistra) e l'etichetta nel lettore, così si vede sempre da dove viene un ticket.

| Scheda | Che cos'è | Come si cerca |
|---|---|---|
| **HDA Touch** (blu) | I ticket di HDA TOUCH | Parole, numero e tutti i filtri a sinistra |
| **Vecchio Cruscotto** (arancio) | La ricerca per parole dell'Area Riservata (anni recenti) | Parole, numero, oggetto, data di apertura, gruppo |
| **Storico** (viola) | La *Ricerca avanzata* dell'Area Riservata: tutti i ticket, anche prima del 2024 | Numero ticket, periodo (riferito all'ultimo aggiornamento o all'apertura), stato aperto/chiuso, codice cliente, gruppo, operatore. **Non cerca per parole** (nel portale i campi oggetto e testo sono disattivati) |

- **Numero ticket** nella casella in alto: si cerca nelle tre fonti insieme. Il ticket si apre da solo e la scheda passa a quella della sua fonte. Se il ticket c'è solo nello Storico si apre da lì.
- **Parole** nella casella in alto: si cercano in HDA Touch e nel Vecchio Cruscotto. La scheda Storico lo dice e propone i suoi filtri.
- **Scheda Storico**: a sinistra compaiono i suoi filtri. Di partenza il periodo è «fino al 2023» (i ticket che il Vecchio Cruscotto non mostra più); con *Tutti gli anni* si cerca su tutto. Senza nessun filtro non parte nessuna ricerca.
- Se la scheda aperta resta vuota e un'altra fonte ha trovato qualcosa, l'app passa da sola a quella.
- **Centro servizi**: Vecchio Cruscotto e Storico cercano solo tra i ticket del tuo centro (es. `PAOW`); i partner usano lo stesso cruscotto con un loro centro, e i loro ticket non devono comparire. L'app legge il centro dal modulo di ricerca del portale (lo stesso da cui lo prende il portale); di riserva lo ricava dai ticket del tuo gruppo di Touch (`G10663HR` → gruppo 10663), oppure lo si scrive in *Diagnostica → Impostazioni → Centro servizi dell'Area Riservata*. Cercando parole, i ticket di un altro centro vengono comunque scartati. Senza centro le parole si cercherebbero in tutti i centri (ticket dei partner compresi): in quel caso un avviso lo dice. Un numero ticket si cerca comunque anche fuori dal centro.
- Il Vecchio Cruscotto riporta solo i codici di cliente, gruppo e operatore: l'app mostra i nomi quando li ha già visti nei risultati dello Storico.
- Per lo Storico serve l'accesso all'Area Riservata (come per il Vecchio Cruscotto). Gli allegati dei ticket dello Storico si aprono dalla scheda del ticket nell'Area Riservata.
- Nelle schede *Archivio locale*, *Preferiti* e *Recenti* ogni riga porta l'etichetta della sua fonte.

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

- I ticket di Touch **con la Z** e quelli del **Vecchio Cruscotto** con le stesse cifre sono ticket diversi: ognuno compare nella scheda della sua fonte e un avviso lo segnala. Un ticket di Touch **senza Z** (migrato) che c'è anche nel Vecchio Cruscotto diventa una riga sola.
- Si apre da solo il ticket nella forma scritta (7 cifre senza Z → prima il ticket senza Z, poi quello di Touch con la Z); con la Z scritta, sempre quello di Touch.
- Cliccando una riga del Vecchio Cruscotto si legge quel ticket (non un ticket di Touch con le stesse cifre).
- Un numero ticket nella casella porta solo a quel ticket e **non tiene conto dei filtri a sinistra**: quando scegli un filtro (gruppo, stato, cliente…) il numero rimasto da una ricerca precedente si toglie da solo, e se scrivi un numero con dei filtri già scelti un avviso lo ricorda (*Togli il numero*).

## Gruppo di lavoro e testo nella casella

- **Gruppo di lavoro** è il *Gruppo owner* del ticket in Touch (es. `Paghe Infinity - Paghe Web P`). Per i ticket assegnati a un gruppo usa *Assegnato a*.
- Con delle parole nella casella di ricerca e un filtro scelto, si cercano le parole **solo nei ticket del filtro**: sopra l'elenco un avviso lo dice e con *Togli il testo* vedi tutti i ticket del gruppo.
- Con più parole, i ticket trovati dal portale vengono verificati tutti (anche oltre i primi 60): se i messaggi di un ticket non si possono leggere, il ticket resta nell'elenco.

## Velocità

- I risultati compaiono **man mano che arrivano**: prima l'oggetto dei ticket di Touch e il Vecchio Cruscotto, poi la ricerca dentro i messaggi di Touch (la più lenta). Sotto l'elenco si vede dove sta ancora cercando.
- Le ricerche fatte negli ultimi 2 minuti tornano **subito dalla memoria**; il pulsante ↻ (Aggiorna) le rifà sempre sul portale.
- Mentre scrivi si cerca dopo una breve pausa e da 3 caratteri (o un numero ticket completo); <kbd>Invio</kbd> cerca subito.
- Quando la ricerca nei messaggi di Touch (che copre anche l'oggetto) ha risposto, quella sull'oggetto non si aspetta più: su tutto lo storico può arrivare al timeout di 25 s.
- Se all'avvio i ticket aperti di tutti i gruppi vanno in timeout, per 12 ore l'app parte direttamente dai ticket aperti del tuo gruppo (senza aspettare di nuovo i 25 s).
- Aprendo un ticket dall'elenco, dati, conversazione e allegati si caricano insieme.
- Nel Vecchio Cruscotto si cerca con testo, oggetto, data di apertura e **Gruppo di lavoro** (il gruppo Touch `G10663HR` è `IdGruppo:10663`); con filtri che lì non esistono (stato, persone, cliente…) si cerca solo in Touch e l'app lo dice.

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
