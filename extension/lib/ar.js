// Connettore per il Vecchio Cruscotto (Area Riservata Zucchetti: www.zucchetti.it/areariservata).
// Permette di cercare e leggere i ticket storici a 5-7 cifre (es. 9018200, 8907717) direttamente in Ricerca TKT.

import { queryTerms, ticketNumber } from "./util.js";
import { htmlToText, cleanText } from "./richtext.js";

export const AR_ORIGIN = "https://www.zucchetti.it";
export const AR_BASE = "https://www.zucchetti.it/areariservata";
export const AR_SEARCH_URL = "https://www.zucchetti.it/areariservata/jsp/sipv_psearch_infi.jsp";

export function resolveArUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("../")) return `${AR_BASE}/${s.slice(3)}`;
  if (s.startsWith("/")) return `${AR_ORIGIN}${s}`;
  return `${AR_BASE}/jsp/${s}`;
}

/**
 * Il centro servizi dell'operatore dal modulo di ricerca del portale (servlet/gspv_winf_search):
 *   <select name='CentroServizi' …><option value=''></option><option value='PAOW' >[HR] Paghe Infinity</option></select>
 *   DeclareWVs('PAOW','',…)   ← il centro preselezionato
 * Con più centri vale quello preselezionato; con uno solo, quello.
 */
export function extractCentreFromForm(html) {
  const s = String(html || "");
  const sel = /<select[^>]*name=['"]CentroServizi['"][^>]*>([\s\S]*?)<\/select>/i.exec(s);
  if (!sel) return "";
  const codes = [...sel[1].matchAll(/<option[^>]*value=['"]([A-Z0-9_]{2,12})['"]/gi)].map((m) => m[1].toUpperCase());
  if (!codes.length) return "";
  if (codes.length === 1) return codes[0];
  const decl = /DeclareWVs\(([^\n<]{0,200})/.exec(s);
  const preset = decl ? [...decl[1].matchAll(/'([A-Z0-9_]{2,12})'/g)].map((m) => m[1]).find((c) => codes.includes(c)) : "";
  return preset || "";
}

export function extractMcidFromHtml(html) {
  const s = String(html || "");
  const cen =
    /\bw_IdCenSer\s*=\s*['"]([A-Z0-9_]{2,12})['"]/.exec(s) ||
    /\bIdCenSer:([A-Z0-9_]{2,12})\b/.exec(s);
  const area = /\bw_pArea\s*=\s*['"]([A-Z0-9_]{3,20})['"]/.exec(s);
  const m =
    /splResults\.m_cID\s*=\s*['"]([0-9a-fA-F]{16,64})['"]/.exec(s) ||
    /['"]spsl_fquery_mc['"][\s\S]{0,400}?\.m_cID\s*=\s*['"]([0-9a-fA-F]{16,64})['"]/.exec(s) ||
    (!s.includes("sipv_ffilters_search_testo") && /\bm_cID\s*[=:]\s*['"]([0-9a-fA-F]{16,64})['"]/.exec(s));
  return {
    mcid: m ? m[1] : null,
    idCenSer: cen ? cen[1] : "",
    pArea: area ? area[1] : "",
  };
}

/**
 * Filtri della scheda Vecchio Cruscotto: quelli della «Ricerca rapida» dell'Area Riservata.
 * dateRef: a quale data si riferisce il periodo ("1" ultimo aggiornamento, "2" apertura); statoBase: "" tutti, "A" aperti, "C" chiusi;
 * group/operator: chi ha in carico il ticket; groupIn/operatorIn: chi vi ha partecipato; searchIn: "2" testo e oggetto, "0" testo, "1" oggetto.
 */
export function emptyArFilters() {
  return { dateFrom: "", dateTo: "", dateRef: "1", statoBase: "", group: "", groupLabel: "", groupIn: "", groupInLabel: "", operator: null, operatorIn: null, clientCode: "", searchIn: "2" };
}

/** Vero se c'è almeno un filtro: allora si può cercare anche senza parole. */
export function hasArFilter(f) {
  if (!f) return false;
  return !!(f.dateFrom || f.dateTo || f.statoBase || f.group || f.groupIn || (f.operator && f.operator.id) || (f.operatorIn && f.operatorIn.id) || String(f.clientCode || "").trim());
}

/** Codice di cliente o operatore → identificativo a 15 cifre del portale ("1234" → "000000000001234"). */
function id15(v) {
  const d = String(v || "").replace(/\D/g, "");
  return d ? d.padStart(15, "0").slice(-15) : "";
}

function fmtSolrTerm(w) {
  const clean = String(w || "").replace(/[()"\\:]/g, " ").trim();
  if (!clean) return "";
  if (/\s/.test(clean)) return `"${clean}"`;
  if (/^[A-Za-z0-9\u00C0-\u017F]{3,}$/.test(clean)) {
    // Singolare e plurale: si toglie la vocale finale (cedolino → cedolin*: cedolini, cedolino…; premio → premi*),
    // ma solo se ne restano almeno cinque lettere, per non allargare troppo le parole corte.
    // Dentro il campo l'operatore è maiuscolo, come lo scrive il portale («detassazione AND maggiorazioni»): in minuscolo
    // potrebbe essere letto come una parola da cercare. Il jolly va in minuscolo perché non passa dall'analisi del testo.
    const root = /^[A-Za-z]{6,}$/.test(clean) && /[aeio]$/i.test(clean) ? clean.slice(0, -1) : clean;
    return `${clean} OR ${root.toLowerCase()}*`;
  }
  return clean;
}

/**
 * Costruisce la query Solr per servlet/spsl_fquery_mc (sintassi verificata dal portale Zucchetti).
 * Tutte le parole inserite sono concatenate con `and` così vengono trovati solo i ticket che le contengono tutte.
 * Per le parole singole di almeno 3 caratteri include anche il prefisso `parola*` (es. `voc` → `voc or voc*`),
 * così radici o parole troncate (es. "voc retributiv") trovano anche "voce", "voci", "retributiva", ecc.
 */
export function buildArQuery({
  text = "",
  subject = "",
  ticketId = "",
  dateFrom = "",
  dateTo = "",
  idCenSer = "",
  groups = [],
  defaultYears = false,
  wideTicketId = false,
  // filtri della Ricerca rapida (con un numero ticket non contano)
  dateRef = "2",
  statoBase = "",
  operator = "",
  clientCode = "",
  groupsIn = [],
  operatorIn = "",
  searchIn = "2",
} = {}) {
  const parts = [];
  const safe = (w) => String(w || "").replace(/[()"\\:]/g, " ").trim();

  if (idCenSer) {
    parts.push(`IdCenSer:${safe(idCenSer)}`);
  }

  const D = dateRef === "1" ? "M" : "A";
  let hasPeriod = false;
  if (ticketId) {
    // un numero ticket si cerca su tutti gli anni
  } else if (dateFrom || dateTo) {
    hasPeriod = true;
    const df = dateFrom ? new Date(dateFrom) : null;
    const dt = dateTo ? new Date(dateTo) : null;
    // solo «dal»: fino a oggi; solo «al»: dai due anni prima (gli anni che il Vecchio Cruscotto ha ancora)
    const okFrom = df && !isNaN(df);
    const okTo = dt && !isNaN(dt);
    const now = new Date();
    const yEnd = okTo ? dt.getFullYear() : okFrom ? Math.max(now.getFullYear(), df.getFullYear()) : null;
    const mEnd = okTo ? dt.getMonth() + 1 : okFrom && df.getFullYear() > now.getFullYear() ? 12 : now.getMonth() + 1;
    const yStart = okFrom ? df.getFullYear() : okTo ? dt.getFullYear() - 2 : null;
    const mStart = okFrom ? df.getMonth() + 1 : 1;
    if (yStart && yEnd && (yEnd - yStart) * 12 + (mEnd - mStart) <= 36) {
      const mParts = [];
      for (let y = yStart; y <= yEnd; y++) {
        const m1 = y === yStart ? mStart : 1;
        const m2 = y === yEnd ? mEnd : 12;
        for (let m = m1; m <= m2; m++) mParts.push(`(IdMese${D}:${m} and IdAnno${D}:${y})`);
      }
      if (mParts.length) parts.push(`( ${mParts.join(" or ")} )`);
    } else if (yStart && yEnd && yEnd >= yStart) {
      // periodo lungo: si filtra per anno, come i mesi qui sopra
      const yParts = [];
      for (let y = Math.max(2015, yStart); y <= yEnd; y++) yParts.push(`(IdAnno${D}:${y} )`);
      if (yParts.length) parts.push(`( ${yParts.join(" or ")} )`);
    }
  } else if (defaultYears && !ticketId) {
    const cy = new Date().getFullYear();
    parts.push(`( (IdAnnoM:${cy - 2} ) or (IdAnnoM:${cy - 1} ) or (IdAnnoM:${cy} ) )`);
  }

  const contentParts = [];
  if (ticketId) {
    const num = safe(ticketNumber(ticketId));
    if (num) {
      contentParts.push(wideTicketId ? `( NumTic:${num} or Testi:(${num}) or Oggetto:(${num}) )` : `NumTic:${num}`);
    }
  } else if (text) {
    for (const w of queryTerms(text)) {
      const sw = fmtSolrTerm(w);
      if (!sw) continue;
      if (searchIn === "0") contentParts.push(`Testi:(${sw})`);
      else if (searchIn === "1") contentParts.push(`Oggetto:(${sw})`);
      else contentParts.push(`( Testi:(${sw}) or Oggetto:(${sw}) )`);
    }
  }

  if (subject) {
    for (const w of queryTerms(subject)) {
      const sw = fmtSolrTerm(w);
      if (sw) contentParts.push(`Oggetto:(${sw})`);
    }
  }

  // Filtri della Ricerca rapida, con i nomi dei campi del portale. Nella ricerca reale del portale:
  //   … and ( Testi:(parola) or Oggetto:(parola) ) and IdOperatore:000000000123456 and IdCliente:000000000001234
  const filterParts = [];
  const nums = (list) => (list || []).map((g) => String(g || "").replace(/\D/g, "")).filter(Boolean);
  // gruppo che ha in carico il ticket (es. "IdGruppo:10663")
  const grp = nums(groups);
  if (grp.length === 1) filterParts.push(`IdGruppo:${grp[0]}`);
  else if (grp.length > 1) filterParts.push(`( ${grp.map((g) => `IdGruppo:${g}`).join(" or ")} )`);
  if (!ticketId) {
    if (id15(operator)) filterParts.push(`IdOperatore:${id15(operator)}`);
    if (id15(clientCode)) filterParts.push(`IdCliente:${id15(clientCode)}`);
    if (statoBase === "A" || statoBase === "C") filterParts.push(`StatoBase:${statoBase}`);
    // gruppi che hanno partecipato: nell'indice sono scritti come numeri con il decimale ("10663.0 50454.0"), quindi si cercano entrambe le forme
    const gin = nums(groupsIn).map((g) => `IdGruppoIn:${g} or IdGruppoIn:${g}.0`);
    if (gin.length) filterParts.push(`( ${gin.join(" or ")} )`);
    if (id15(operatorIn)) filterParts.push(`IdOperatoreIn:${id15(operatorIn)}`);
  }
  // senza parole si cerca solo se c'è almeno un filtro (o un periodo scelto): mai tutto il centro servizi
  if (!contentParts.length && !filterParts.length && !hasPeriod) return "";
  return [...parts, ...contentParts, ...filterParts].join(" and ");
}

function parseArDate(str) {
  const s = String(str || "").trim();
  if (!s) return null;
  // Formato DataApe: "2026-09-02 15:30:31.0"
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/.exec(s);
  if (iso) {
    const d = new Date(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4] || 12),
      Number(iso[5] || 0),
      Number(iso[6] || 0),
    );
    return isNaN(d) ? null : d;
  }
  // Formato description: "02-09-2026"
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (dmy) {
    const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]), 12, 0, 0);
    return isNaN(d) ? null : d;
  }
  return null;
}

/**
 * Estrae il payload JSON da `spsl_fquery_mc`, che può essere sia una pagina HTML
 * con commento `<!-- Function return value:{"data":[...],"fields":[...]} -->` sia JSON puro.
 */
export function extractArJson(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  const s = String(raw);
  // Regex greedy `[\s\S]*` così eventuali `-->` scritti dentro il testo di un ticket non troncano il JSON
  const m = /Function return value:\s*(\{[\s\S]*\})\s*-->/.exec(s);
  const candidate = m ? m[1].trim() : s.trim();
  if (!candidate || (!candidate.startsWith("{") && !candidate.startsWith("["))) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Converte la risposta di `spsl_fquery_mc` in righe compatibili con l'elenco di Ricerca TKT.
 */
export function parseArResponse(raw) {
  const json = extractArJson(raw);
  if (!json || typeof json !== "object") return [];
  const fields = Array.isArray(json.fields) ? json.fields : [];
  const data = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
  const out = [];
  const seen = new Set();

  for (const r of data) {
    let obj = {};
    if (Array.isArray(r) && fields.length) {
      fields.forEach((f, idx) => {
        obj[f] = r[idx];
        obj[String(f).toLowerCase()] = r[idx];
      });
    } else if (r && typeof r === "object" && !Array.isArray(r)) {
      for (const [k, v] of Object.entries(r)) {
        obj[k] = v;
        obj[k.toLowerCase()] = v;
      }
    } else {
      // Scarta la riga sentinella finale di SitePainter ("t,CCCCCCCC..., -1")
      continue;
    }

    const desc = cleanText(htmlToText(String(obj.description || "")));
    const altDesc = cleanText(htmlToText(String(obj.altdescription || "")));
    const fullText = String(obj.testi || "");
    const url = obj.url1 || obj.urlpublic || "";
    const dm = /\[#(\d+)\]\s*(?:\[([^\]]*)\])?\s*(?:\[(\d{2}-\d{2}-\d{4})\])?\s*(.*)/.exec(desc);

    const numTic = String(obj.numtic || "").trim();
    const id =
      (/^\d+$/.test(numTic) && numTic) ||
      (dm ? dm[1] : (String(obj.id || "").replace(/^0+/, "").match(/^\d{5,8}$/) || [])[0] || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const product = String(obj.idprodotto || (dm && dm[2]) || "").trim();
    const date = parseArDate(obj.dataape) || (dm && dm[3] ? parseArDate(dm[3]) : null);
    const rawOggetto = cleanText(htmlToText(String(obj.oggetto || "")));
    const subject = rawOggetto || (dm && dm[4] ? dm[4].trim() : desc) || `Ticket #${id}`;
    const statoRaw = String(obj.idstato || "").trim().toUpperCase();
    const isClosed = statoRaw === "CLOSE" || String(obj.statobase || "").trim().toUpperCase() === "C";
    const statusText = isClosed
      ? "Chiuso (Vecchio cruscotto)"
      : statoRaw
        ? `${statoRaw} (Vecchio cruscotto)`
        : "Vecchio cruscotto";
    const tipologia = String(obj.idtipologia || obj.type || "").trim();
    const cenSer = String(obj.idcenser || "").trim();
    const gruppo = String(obj.idgruppo || "").trim();
    const ownerGroup = [cenSer, gruppo].filter(Boolean).join(" · ");
    const operatore = String(obj.idoperatore || "").replace(/^0+/, "").trim();
    const cliente = String(obj.idcliente || "").replace(/^0+/, "").trim();

    out.push({
      id,
      ttCodice: String(obj.id || "").trim(),
      source: "ar",
      arUrl: resolveArUrl(url),
      subject,
      catalog: product,
      date,
      lastChange: date,
      // S5 = "Chiuso" di Touch (S8 è "Feedback/Risposta ricevuta", uno stato aperto)
      statusId: isClosed ? "S5" : "AR",
      statusText,
      typeId: tipologia || "AR",
      typeText: tipologia ? `${tipologia} · Vecchio cruscotto` : "Vecchio cruscotto",
      priority: String(obj.idpriorita || "").trim(),
      problem: altDesc || cleanText(fullText.replace(/  +/g, " — ")),
      fullText,
      account: cliente ? `Cliente ${cliente}` : "",
      customerCode: cliente,
      contact: "",
      ownerGroup,
      ownerGroupId: gruppo,
      cenSer,
      assigned: operatore ? `Op. ${operatore}` : "",
      assignedId: operatore ? operatore.padStart(15, "0") : "",
    });
  }
  return out;
}

/**
 * Divide il campo `Testi` di `spsl_fquery_mc` (dove Solr concatena i singoli messaggi del ticket
 * separandoli con doppi spazi ASCII `"  "`) in messaggi distinti per la conversazione.
 */
export function splitArTesti(fullText, subject = "") {
  const raw = String(fullText || "");
  if (!raw.trim()) return [];
  const rawParts = raw
    .split(/  +/)
    .map((p) => cleanText(p.replace(/\u00a0/g, " ")))
    .filter(Boolean);
  if (!rawParts.length) return [];

  const subjLow = String(subject || "").trim().toLowerCase();
  // Se il primo frammento ripete solo l'oggetto del ticket e ci sono altri messaggi, lo saltiamo
  const parts =
    rawParts.length > 1 && subjLow && rawParts[0].toLowerCase() === subjLow ? rawParts.slice(1) : rawParts;

  const isDispatcher = (t) => /^Ticket (?:pre)?assegnato dal dispatcher/i.test(t);
  const isAutoClose = (t) => /^Gentile cliente,\s*In riferimento alla richiesta di assistenza/i.test(t);

  // Troviamo l'indice del primo e dell'ultimo messaggio sostanziale (non di sistema)
  const substantiveIdxs = [];
  parts.forEach((p, idx) => {
    if (!isDispatcher(p) && !isAutoClose(p)) substantiveIdxs.push(idx);
  });
  const firstSub = substantiveIdxs.length ? substantiveIdxs[0] : -1;
  const lastSub = substantiveIdxs.length > 1 ? substantiveIdxs[substantiveIdxs.length - 1] : -1;

  const entries = [];
  let lastWasDispatcher = false;
  parts.forEach((p, idx) => {
    if (isDispatcher(p)) {
      if (lastWasDispatcher) return;
      lastWasDispatcher = true;
      entries.push({
        kind: "message",
        role: "system",
        internal: true,
        author: "Dispatcher automatico",
        text: p,
      });
      return;
    }
    lastWasDispatcher = false;
    if (isAutoClose(p)) {
      entries.push({
        kind: "message",
        role: "system",
        internal: true,
        author: "Chiusura automatica",
        text: p,
      });
      return;
    }
    if (idx === firstSub) {
      entries.push({
        kind: "request",
        role: "customer",
        author: "Richiesta iniziale",
        text: p,
      });
    } else if (idx === lastSub) {
      entries.push({
        kind: "solution",
        role: "operator",
        author: "Risposta / Soluzione",
        text: p,
      });
    } else {
      const posInSub = substantiveIdxs.indexOf(idx);
      const isCustomerReply = posInSub > 0 && posInSub % 2 === 0;
      entries.push({
        kind: "message",
        role: isCustomerReply ? "customer" : "operator",
        author: isCustomerReply ? "Replica cliente" : "Risposta operatore",
        text: p,
      });
    }
  });
  return entries;
}

/**
 * Combina la riga Solr e gli eventuali dati estratti dalla pagina JSP del vecchio cruscotto
 * nel formato `{ id, row, ticket, items, timeline, notes, source: "ar", arUrl, extraFacts }` per il lettore.
 */
export function buildArTicket({ id, row = null, detail = null } = {}) {
  const cleanId = ticketNumber(id || (row && row.id) || "");
  const r = {
    id: cleanId,
    source: "ar",
    arUrl: (detail && detail.url) || (row && row.arUrl) || "",
    subject: (row && row.subject) || (detail && detail.title) || `Ticket #${cleanId}`,
    catalog: (row && row.catalog) || "",
    date: (row && row.date) || null,
    lastChange: (row && row.lastChange) || (row && row.date) || null,
    statusId: (row && row.statusId) || "AR",
    statusText: (row && row.statusText) || "Vecchio cruscotto",
    typeId: (row && row.typeId) || "AR",
    typeText: (row && row.typeText) || "Vecchio cruscotto",
    priority: (row && row.priority) || "",
    problem: (row && row.problem) || "",
    fullText: (row && row.fullText) || "",
    account: (row && row.account) || "",
    contact: (row && row.contact) || "",
    ownerGroup: (row && row.ownerGroup) || "",
    assigned: (row && row.assigned) || "",
    // i codici servono per ritrovare i nomi (cliente, gruppo, operatore) e la scheda del ticket
    ttCodice: (row && row.ttCodice) || "",
    customerCode: (row && row.customerCode) || "",
    ownerGroupId: (row && row.ownerGroupId) || "",
    assignedId: (row && row.assignedId) || "",
    cenSer: (row && row.cenSer) || "",
  };

  const extraFacts = [];
  if (r.priority) extraFacts.push(["Priorità", r.priority]);
  if (row && row.ttCodice) extraFacts.push(["Codice scheda", row.ttCodice]);

  if (detail && Array.isArray(detail.fields)) {
    for (const [k, v] of detail.fields) {
      const lk = String(k || "").toLowerCase();
      if (!r.account && /cliente|ragione\s*sociale|azienda|ditta/.test(lk)) r.account = v;
      else if (!r.contact && /contatto|riferimento|utente|richiedente/.test(lk)) r.contact = v;
      else if (!r.catalog && /prodotto|applicativo|modulo|procedura/.test(lk)) r.catalog = v;
      else if (!r.ownerGroup && /gruppo|centro|reparto/.test(lk)) r.ownerGroup = v;
      else if (!r.assigned && /operatore|assegnat|incaricat|analista/.test(lk)) r.assigned = v;
      else if (/^stato\b/.test(lk)) r.statusText = v;
      else if (/oggetto|titolo/.test(lk) && (!r.subject || r.subject === `Ticket #${cleanId}`)) r.subject = v;
      else extraFacts.push([k, v]);
    }
  }

  const timeline = [];
  const seenText = new Set();
  const pushEntry = (entry) => {
    const t = cleanText(entry.text || "");
    if (!t) return;
    const sig = t.slice(0, 160).toLowerCase();
    if (seenText.has(sig)) return;
    seenText.add(sig);
    timeline.push({ ...entry, text: t });
  };

  // 1. Se abbiamo il testo completo della conversazione da Solr (`Testi` in spsl_fquery_mc), lo dividiamo nei vari messaggi
  if (r.fullText) {
    for (const entry of splitArTesti(r.fullText, r.subject)) {
      pushEntry({
        ...entry,
        date: entry.kind === "request" ? r.date : null,
        account: r.account,
      });
    }
  }

  // 2. Eventuali campi testuali aggiuntivi dalla scheda JSP
  if (detail && Array.isArray(detail.texts) && detail.texts.length) {
    detail.texts.forEach(([label, val], idx) => {
      const ll = String(label || "").toLowerCase();
      let kind = "message";
      let role = "operator";
      if ((idx === 0 && !timeline.length) || /richiesta|problema|domanda|segnalazione|descrizione/.test(ll)) {
        kind = "request";
        role = "customer";
      } else if (/soluzione|risposta|esito|chiusura/.test(ll)) {
        kind = "solution";
        role = "operator";
      }
      pushEntry({
        kind,
        date: kind === "request" ? r.date : null,
        role,
        author: label || (kind === "request" ? r.contact || r.account || "Cliente" : "Vecchio cruscotto"),
        account: r.account,
        text: val,
      });
    });
  }

  // 3. Fallback sul riepilogo `problem` se non c'era `fullText`
  if (!timeline.length && r.problem) {
    pushEntry({
      kind: "request",
      date: r.date,
      role: "customer",
      author: r.contact || r.account || "Testo dal vecchio cruscotto",
      account: r.account,
      text: r.problem,
    });
  }

  if (detail && Array.isArray(detail.tables)) {
    for (const tbl of detail.tables) {
      const lines = [];
      if (tbl.headers && tbl.headers.some(Boolean)) lines.push(tbl.headers.filter(Boolean).join(" · "));
      for (const tr of tbl.rows || []) {
        const line = tr.filter(Boolean).join(" — ");
        if (line) lines.push(line);
      }
      if (lines.length) {
        pushEntry({
          kind: "message",
          date: null,
          role: "system",
          author: "Tabella / Storico",
          text: lines.join("\n"),
        });
      }
    }
  }

  if (!timeline.length && detail && detail.bodyText) {
    pushEntry({
      kind: "request",
      date: r.date,
      role: "customer",
      author: r.contact || r.account || "Vecchio cruscotto",
      text: detail.bodyText,
    });
  }

  const notes = ["Ticket storico dal Vecchio Cruscotto (Area Riservata Zucchetti)."];
  const attachments = Array.isArray(detail && detail.attachments) ? detail.attachments : [];
  return {
    id: cleanId,
    source: "ar",
    arUrl: r.arUrl,
    row: r,
    ticket: null,
    items: [],
    attachments,
    timeline,
    notes,
    extraFacts,
  };
}

/**
 * Client per il Vecchio Cruscotto: usa in priorità la scheda Area Riservata aperta tramite background.js,
 * con fallback a fetch diretto dall'estensione.
 */
export function makeAr({ log = () => {}, fetch: fetchImpl = globalThis.fetch } = {}) {
  const inExt = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
  const state = { connected: null, mcid: null, pArea: "TICKOPEXXX", idCenSer: "" };
  // dopo un collegamento diretto fallito non si riprova a ogni ricerca (sono 2-4 richieste in più):
  // si riprova dopo un minuto, o subito con checkStatus (al ritorno sulla scheda dell'app)
  const DIRECT_RETRY_MS = 60 * 1000;
  let directFailedAt = 0;

  async function sendBridge(payload) {
    if (!inExt) return { error: "no-ext" };
    try {
      return (await chrome.runtime.sendMessage({ type: "ar-proxy", ...payload })) || { error: "empty" };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  async function discoverDirect() {
    if (!fetchImpl) return false;
    // 1. La chiamata POST a spsl_wsolrresultsgrid_portlet.jsp con clientsideinclusion=true
    //    inizializza la portlet in sessione e restituisce `this.splResults.m_cID='...'`
    for (const portlet of ["spsl_wsolrresultsgrid_portlet.jsp", "gspl_wsolrresultsgrid_portlet.jsp"]) {
      try {
        const r = await fetchImpl(`${AR_BASE}/jsp/${portlet}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: "clientsideinclusion=true",
        });
        if (!r.ok) continue;
        const info = extractMcidFromHtml(await r.text());
        if (info.idCenSer) state.idCenSer = info.idCenSer;
        if (info.pArea) state.pArea = info.pArea;
        if (info.mcid) {
          state.mcid = info.mcid;
          state.connected = true;
        }
      } catch {
        /* */
      }
    }
    // 2. Legge anche la pagina contenitore per eventuale w_IdCenSer / w_pArea
    if (!state.idCenSer || !state.mcid) {
      for (const url of [`${AR_BASE}/jsp/sipv_psearch_infi.jsp`, `${AR_BASE}/jsp/gspv_psearch.jsp`]) {
        try {
          const r = await fetchImpl(url, { credentials: "include" });
          if (!r.ok) continue;
          const info = extractMcidFromHtml(await r.text());
          if (info.idCenSer) state.idCenSer = info.idCenSer;
          if (info.pArea) state.pArea = info.pArea;
          if (info.mcid && !state.mcid) state.mcid = info.mcid;
        } catch {
          /* */
        }
      }
    }
    if (state.mcid) {
      state.connected = true;
      directFailedAt = 0;
      return true;
    }
    directFailedAt = Date.now();
    return false;
  }

  async function checkStatus() {
    directFailedAt = 0;
    const res = await sendBridge({ cmd: "status" });
    if (res && res.ok && res.mcid) {
      state.mcid = res.mcid;
      if (res.pArea) state.pArea = res.pArea;
      if (res.idCenSer) state.idCenSer = res.idCenSer;
      state.connected = true;
      return { connected: true, mode: "tab", idCenSer: state.idCenSer };
    }
    if (await discoverDirect()) {
      return { connected: true, mode: "direct", idCenSer: state.idCenSer };
    }
    state.connected = false;
    return { connected: false };
  }

  /** info (facoltativo) riceve: max = quanti ticket al massimo restituisce il portale per ricerca, raw = quanti ne ha restituiti. */
  async function rawQuery(query, info = {}) {
    if (!query) return [];
    const t0 = Date.now();
    const read = (text) => {
      const json = extractArJson(text);
      const rows = parseArResponse(json || text);
      info.max = Number(json && Array.isArray(json.maxResults) ? json.maxResults[0] : 0) || 0;
      info.raw = rows.length;
      return rows;
    };
    const viaTab = await sendBridge({ cmd: "search", query, pArea: state.pArea });
    if (viaTab && viaTab.ok && viaTab.text) {
      if (viaTab.mcid) state.mcid = viaTab.mcid;
      if (viaTab.pArea) state.pArea = viaTab.pArea;
      if (viaTab.idCenSer) state.idCenSer = viaTab.idCenSer;
      const rows = read(viaTab.text);
      state.connected = true;
      log(`vecchio cruscotto: ${rows.length} risultati (${Date.now() - t0} ms, scheda)`);
      return rows;
    }

    if (!state.mcid && (!directFailedAt || Date.now() - directFailedAt > DIRECT_RETRY_MS)) await discoverDirect();
    if (!state.mcid || !fetchImpl) {
      state.connected = false;
      throw new Error("Vecchio cruscotto non collegato");
    }

    const doDirectPost = async () => {
      const body =
        `pKeyword=${encodeURIComponent(query)}` +
        `&pArea=${encodeURIComponent(state.pArea || "TICKOPEXXX")}` +
        `&pCore=&pLangs=ITA&cs_SITE=&m_cID=${encodeURIComponent(state.mcid)}`;
      const r = await fetchImpl(`${AR_BASE}/servlet/spsl_fquery_mc`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body,
      });
      return await r.text();
    };

    let text = await doDirectPost();
    if (!extractArJson(text)) {
      state.mcid = null;
      if (await discoverDirect()) text = await doDirectPost();
    }
    const rows = read(text);
    state.connected = true;
    log(`vecchio cruscotto: ${rows.length} risultati (${Date.now() - t0} ms, direct)`);
    return rows;
  }

  /**
   * filters: i filtri della scheda Vecchio Cruscotto (emptyArFilters). Con un numero ticket non contano.
   * info (facoltativo) riceve la ricerca mandata al portale (query) e il suo limite di risultati (max, raw).
   */
  async function search({ text = "", subject = "", ticketId = "", dateFrom = "", dateTo = "", groups = [], filters = null } = {}, info = {}) {
    const F = filters && !ticketId ? filters : {};
    const base = {
      text,
      subject,
      ticketId,
      dateFrom: F.dateFrom || dateFrom,
      dateTo: F.dateTo || dateTo,
      dateRef: filters ? F.dateRef || "1" : "2",
      groups: F.group ? [F.group] : groups,
      statoBase: F.statoBase || "",
      operator: (F.operator && F.operator.id) || "",
      clientCode: F.clientCode || "",
      groupsIn: F.groupIn ? [F.groupIn] : [],
      operatorIn: (F.operatorIn && F.operatorIn.id) || "",
      searchIn: F.searchIn || "2",
      defaultYears: false,
    };
    const q1 = buildArQuery({ ...base, idCenSer: state.idCenSer });
    if (!q1) return [];
    info.query = q1;
    if (!ticketId) log(`vecchio cruscotto, ricerca: ${q1.replace(/\b(Id(?:Operatore|OperatoreIn|Cliente)):\d+/g, "$1:…")}`);
    let rows = await rawQuery(q1, info);
    if (!rows.length && ticketId) {
      // Solo per un numero ticket: si riprova senza il centro servizi e cercando il numero anche nel testo dei messaggi.
      // Per le parole no: fuori dal proprio centro si troverebbero i ticket degli altri centri (partner compresi).
      const q2 = buildArQuery({ ...base, idCenSer: "", wideTicketId: true });
      if (q2 && q2 !== q1) rows = await rawQuery(q2, info);
    }
    // I partner usano lo stesso cruscotto con un loro centro servizi: senza un numero restano solo i ticket del proprio centro
    if (!ticketId && state.idCenSer) rows = rows.filter((r) => !r.cenSer || r.cenSer === state.idCenSer);
    // Con più parole la ricerca le chiede già tutte al portale (in «and»). Qui NON si ricontrolla: il portale riconosce
    // forme della parola e testi che nella risposta possono non esserci per intero, e ricontrollando sul testo ricevuto
    // si scartavano ticket buoni. L'ordine per attinenza porta comunque in alto quelli con tutte le parole vicine.
    info.kept = rows.length;
    if (ticketId) {
      const num = ticketNumber(ticketId);
      rows.sort((a, b) => (a.id === num ? -1 : b.id === num ? 1 : 0));
    }
    return rows;
  }

  /**
   * Oltre il limite del portale (210 ticket per ricerca): la stessa ricerca divisa per periodi e riunita.
   * Si parte dagli anni; un periodo che torna ancora pieno si divide a metà, fino al singolo mese.
   * Il periodo si riferisce alla data scelta nei filtri (ultimo aggiornamento o apertura): ogni ticket sta in un mese solo.
   * → { rows, queries, cappedMonths (mesi ancora troncati), stopped (fermato prima della fine) }
   */
  async function searchAll(opts = {}, { onProgress = () => {}, isCancelled = () => false, maxRows = 1500, maxQueries = 45 } = {}) {
    const F = { ...emptyArFilters(), ...(opts.filters || {}) };
    const now = new Date();
    const monthOf = (day, fallback) => {
      const m = /^(\d{4})-(\d{2})/.exec(String(day || ""));
      return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : fallback;
    };
    // senza periodo: gli anni che il Vecchio Cruscotto ha ancora (i due precedenti e quello in corso)
    const first = monthOf(F.dateFrom, (now.getFullYear() - 2) * 12);
    const last = Math.max(first, monthOf(F.dateTo, now.getFullYear() * 12 + now.getMonth()));
    const p2 = (n) => String(n).padStart(2, "0");
    const firstDay = (m) => `${Math.floor(m / 12)}-${p2((m % 12) + 1)}-01`;
    const lastDay = (m) => `${Math.floor(m / 12)}-${p2((m % 12) + 1)}-${p2(new Date(Math.floor(m / 12), (m % 12) + 1, 0).getDate())}`;
    // dal periodo più recente
    const queue = [];
    for (let y = Math.floor(last / 12); y >= Math.floor(first / 12); y--) queue.push([Math.max(first, y * 12), Math.min(last, y * 12 + 11)]);
    const found = new Map();
    const cappedMonths = [];
    let queries = 0;
    let stopped = false;
    while (queue.length) {
      if (isCancelled()) return { rows: [...found.values()], queries, cappedMonths, stopped: true, cancelled: true };
      if (queries >= maxQueries || found.size >= maxRows) {
        stopped = true;
        break;
      }
      const [a, b] = queue.shift();
      const info = {};
      const rows = await search({ ...opts, ticketId: "", filters: { ...F, dateFrom: firstDay(a), dateTo: lastDay(b) } }, info);
      queries++;
      const full = info.max > 0 && info.raw >= info.max;
      if (full && b > a) {
        const mid = Math.floor((a + b) / 2);
        queue.unshift([mid + 1, b], [a, mid]);
        continue;
      }
      if (full) cappedMonths.push(firstDay(a).slice(0, 7));
      for (const r of rows) if (!found.has(r.id)) found.set(r.id, r);
      onProgress({ rows: found.size, queries, left: queue.length });
    }
    return { rows: [...found.values()], queries, cappedMonths, stopped };
  }

  async function readDetail(url) {
    if (!url) return null;
    const res = await sendBridge({ cmd: "read", url });
    if (res && res.ok && res.data) return res.data;
    return null;
  }

  async function loadTicket(id, { row = null } = {}) {
    const num = ticketNumber(id);
    if (!row || (!row.fullText && !row.arUrl && !row.problem)) {
      // solo il ticket con quel numero: gli altri risultati (che citano il numero nel testo) sono ticket diversi
      const found = await search({ ticketId: num });
      const exact = found.find((r) => r.id === num) || null;
      if (exact) row = { ...(row || {}), ...exact };
    }
    if (!row) throw new Error(`Ticket #${num} non trovato nel Vecchio Cruscotto`);
    let detail = null;
    // Se spsl_fquery_mc ci ha già restituito l'intera conversazione in `fullText` (colonna Testi),
    // mostriamo subito il ticket senza attendere il caricamento dell'iframe JSP.
    if (!row.fullText && row.arUrl) {
      try {
        detail = await readDetail(row.arUrl);
      } catch (e) {
        log(`dettaglio vecchio cruscotto #${num}: ${e.message}`);
      }
    }
    return buildArTicket({ id: num, row, detail });
  }

  /**
   * Richiesta di sola lettura a una pagina dell'Area Riservata (usata dallo Storico): prima dalla scheda
   * dell'Area Riservata aperta (stessa sessione del portale), altrimenti direttamente dall'estensione.
   * path: "/jsp/…" o "/servlet/…". Ritorna il testo della risposta.
   */
  async function request(path, { method = "GET", body = null } = {}) {
    if (!/^\/(jsp|servlet)\//.test(String(path || ""))) throw new Error("Percorso non ammesso");
    const viaTab = await sendBridge({ cmd: "fetch", path, method, body });
    if (viaTab && viaTab.ok && typeof viaTab.text === "string" && viaTab.status < 400) return viaTab.text;
    if (!fetchImpl) throw new Error("Area Riservata non raggiungibile");
    const r = await fetchImpl(`${AR_BASE}${path}`, {
      method,
      credentials: "include",
      headers: body != null ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {},
      body: body != null ? body : undefined,
    });
    if (!r.ok) throw new Error(`L'Area Riservata ha risposto ${r.status}`);
    return await r.text();
  }

  /**
   * Il centro servizi dell'operatore (es. "PAOW"). La pagina dei risultati non lo riporta: il portale lo aggiunge
   * alla ricerca dal suo modulo. Lo si legge da quel modulo; di riserva lo si ricava dai ticket del gruppo
   * dell'operatore (in Touch "G10663HR" = gruppo 10663): ogni ticket trovato riporta il suo centro (campo IdCenSer).
   */
  async function findCentre(groups = []) {
    if (state.idCenSer) return state.idCenSer;
    // 1. dal modulo di ricerca del portale: è lì che il portale stesso prende il centro
    for (const form of ["/servlet/gspv_winf_search?m_cDecoration=none", "/servlet/gspv_wsearch?m_cDecoration=none"]) {
      try {
        const c = extractCentreFromForm(await request(form));
        if (c) {
          state.idCenSer = c;
          log(`vecchio cruscotto: centro servizi ${c} (dal modulo di ricerca del portale)`);
          return c;
        }
      } catch (e) {
        log(`centro servizi dal modulo di ricerca: ${e.message}`);
      }
    }
    // 2. dai ticket del proprio gruppo
    for (const g of groups) {
      const num = String(g || "").replace(/\D/g, "");
      if (!num) continue;
      const rows = await rawQuery(`IdGruppo:${num}`);
      const count = new Map();
      for (const r of rows) if (r.cenSer && r.ownerGroupId === num) count.set(r.cenSer, (count.get(r.cenSer) || 0) + 1);
      const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best) {
        state.idCenSer = best[0];
        log(`vecchio cruscotto: centro servizi ${best[0]} (dai ticket del gruppo ${num})`);
        return best[0];
      }
    }
    return "";
  }

  function setCentre(c) {
    const v = String(c || "").trim().toUpperCase();
    if (/^[A-Z0-9_]{2,12}$/.test(v)) state.idCenSer = v;
  }

  function openHome(url) {
    const target = resolveArUrl(url) || AR_SEARCH_URL;
    if (inExt && chrome.tabs) chrome.tabs.create({ url: target });
    else window.open(target, "_blank");
  }

  return {
    get state() {
      return state;
    },
    checkStatus,
    search,
    searchAll,
    loadTicket,
    request,
    findCentre,
    setCentre,
    openHome,
  };
}
