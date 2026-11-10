# Ricerca TKT — Estensione Chrome / Edge (v4)

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

- I ticket di Touch **con la Z** e quelli del **Vecchio Cruscotto** con le stesse cifre sono ticket diversi: compaiono entrambi nell'elenco (le righe del Vecchio Cruscotto hanno l'etichetta *Vecchio cruscotto*) e un avviso lo segnala. Un ticket di Touch **senza Z** (migrato) che c'è anche nel Vecchio Cruscotto diventa una riga sola.
- Si apre da solo il ticket nella forma scritta (7 cifre senza Z → prima il ticket senza Z, poi quello di Touch con la Z); con la Z scritta, sempre quello di Touch.
- Cliccando una riga del Vecchio Cruscotto si legge quel ticket (non un ticket di Touch con le stesse cifre).

## Velocità

- I risultati compaiono **man mano che arrivano**: prima l'oggetto dei ticket di Touch e il Vecchio Cruscotto, poi la ricerca dentro i messaggi di Touch (la più lenta). Sotto l'elenco si vede dove sta ancora cercando.
- Le ricerche fatte negli ultimi 2 minuti tornano **subito dalla memoria**; il pulsante ↻ (Aggiorna) le rifà sempre sul portale.
- Mentre scrivi si cerca dopo una breve pausa e da 3 caratteri (o un numero ticket completo); <kbd>Invio</kbd> cerca subito.
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
