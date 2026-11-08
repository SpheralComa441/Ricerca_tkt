// Stati, tipi e priorità dei ticket HDA (codici visti nel portale Zucchetti).
// Le descrizioni vere arrivano dal portale (GetStaticList); qui ci sono le etichette italiane
// e il raggruppamento in Aperti / In attesa / Chiusi, che il portale non ha.

export const STATUS_GROUPS = [
  { key: "open", label: "Aperti", tone: "blue" },
  { key: "waiting", label: "In attesa", tone: "amber" },
  { key: "closed", label: "Chiusi", tone: "gray" },
];

export const STATUSES = {
  S1: { it: "Nuovo", group: "open" },
  S2: { it: "In lavorazione", group: "open" },
  Z5C: { it: "Assegnato", group: "open" },
  Z4C: { it: "Riaperto", group: "open" },
  S8: { it: "Risposta ricevuta", group: "open" },
  S10: { it: "Inoltrato", group: "open" },
  Z3C: { it: "Appuntamento raggiunto", group: "open" },
  Z19Z: { it: "Intervento pianificato", group: "open" },
  S12: { it: "Autorizzato", group: "open" },
  S14: { it: "Valutazione E/CAB", group: "open" },
  S15: { it: "Rivalutazione", group: "open" },
  S17: { it: "Implementazione", group: "open" },
  S18: { it: "Test", group: "open" },
  S19: { it: "Rilascio", group: "open" },
  S20: { it: "Rollback", group: "open" },
  S21: { it: "Revisione post implementazione", group: "open" },
  S3: { it: "In attesa del cliente", group: "waiting" },
  S7: { it: "In attesa di reparto interno", group: "waiting" },
  S11: { it: "In attesa di fornitore esterno", group: "waiting" },
  S9: { it: "In attesa di autorizzazione", group: "waiting" },
  Z2C: { it: "In attesa di appuntamento", group: "waiting" },
  Z18Z: { it: "In attesa di materiale", group: "waiting" },
  Z24C: { it: "Sospeso pianificato", group: "waiting" },
  Z25C: { it: "Sospeso concordato", group: "waiting" },
  Z26C: { it: "Prenotifica CSIRT inoltrata", group: "waiting" },
  Z27C: { it: "Notifica CSIRT inoltrata", group: "waiting" },
  Z6C: { it: "Bozza", group: "waiting" },
  S5: { it: "Chiuso", group: "closed" },
  S6: { it: "Risolto", group: "closed" },
  Z7C: { it: "Chiusura diretta", group: "closed" },
  S4: { it: "Scartato", group: "closed" },
  S13: { it: "Non autorizzato", group: "closed" },
};

export function statusInfo(id, fallbackText) {
  const s = STATUSES[id];
  if (s) return { id, label: s.it, group: s.group };
  return { id, label: fallbackText || id || "—", group: "open" };
}

export function statusesOfGroup(group) {
  return Object.entries(STATUSES)
    .filter(([, s]) => s.group === group)
    .map(([id]) => id);
}

/** Unisce le descrizioni del portale (GetStaticList TicketStatuses) con le etichette italiane */
export function mergePortalStatuses(rows) {
  for (const r of rows || []) {
    const id = r.ID || r.StatusID;
    if (!id) continue;
    if (!STATUSES[id]) {
      const d = String(r.TranslatedDescription || r.Description || id);
      const closed = /clos|chius|solv|risolt|discard|scart/i.test(d);
      const waiting = /await|attesa|sospes|pending|draft|bozza|waiting/i.test(d);
      STATUSES[id] = { it: d, group: closed ? "closed" : waiting ? "waiting" : "open" };
    }
  }
}

export const PRIORITIES = {
  P1: "P1 - Critica",
  P2: "P2 - Alta",
  P3: "P3 - Media",
  P4: "P4 - Bassa",
};

// Tipi visti nell'elenco "All tickets" (descrizioni dal portale quando disponibili)
export const TICKET_TYPES = {
  T10Z: "Informazione",
};
