// Client dei servizi dati del portale HDA TOUCH (gli stessi che usa l'interfaccia di Touch).
//
// Verificati sulle richieste reali (HAR del 07/11/2026):
//   POST /WSCView/ListData/<Collection>       elenco filtrato e paginato (colonne c0…cN)
//   POST /WSCView/List?Entity=<Collection>    configurazione dell'elenco (JS: colonne e filtri)
//   POST /WSC/Projection                      colonne scelte di un'entità, con filtro
//   GET  /WSCView/GetObjectAndDescription/<id>?entity=<Collection>
//   GET  /WSCView/GetStaticList?entity=TicketStatuses
//   POST /WSC/RunAnalysis                     analisi del portale (es. riepilogo ticket)
// Da verificare (usati solo come alternativa): POST /WSC/Get/<Entity>/<id>, ObjectSearch con "query".
//
// Solo letture: l'estensione non chiama mai Save, Delete, Lock o Close.

import { formBody, query, HdaError } from "./transport.js";
import { parseListConfig } from "./listconfig.js";
import { filterPayload } from "./filters.js";

export function makeHda(transport, opts = {}) {
  const pl = opts.lang || "en";
  let lastUserId = null;

  function noteToken(data) {
    // il portale rimanda un token firmato; se ne legge solo l'utente (wsc_uid), mai lo si salva
    if (lastUserId || !data || typeof data.requestToken !== "string") return;
    try {
      let jwt = data.requestToken;
      if (!jwt.includes(".")) jwt = atob(jwt);
      const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (payload && payload.wsc_uid) lastUserId = String(payload.wsc_uid);
    } catch {
      /* formato diverso: pazienza */
    }
  }

  async function post(path, params, expect = "json", signal) {
    const data = await transport.request({ path, method: "POST", body: formBody(params), expect, signal });
    if (expect === "json") noteToken(data);
    return data;
  }
  async function get(path, signal) {
    const data = await transport.request({ path, method: "GET", expect: "json", signal });
    noteToken(data);
    return data;
  }

  return {
    get currentUserId() {
      return lastUserId;
    },

    /** Elenco filtrato. conditions = array di condizioni; sort = [{property:"c20",direction:"DESC"}] */
    async listData(collection, { viewId = "Default", conditions = [], page = 1, start = 0, limit = 50, sort = [], signal } = {}) {
      const data = await post(
        `/WSCView/ListData/${encodeURIComponent(collection)}?_pl=${pl}&_dc=${Date.now()}`,
        { ViewID: viewId, FilterAreaID: "", MinFilters: "", filter: filterPayload(conditions), page, start, limit, sort },
        "json",
        signal,
      );
      return { rows: Array.isArray(data.data) ? data.data : [], total: Number(data.total) || 0 };
    },

    /** Configurazione dell'elenco (risposta JS) già interpretata */
    async listConfig(collection, extra = {}) {
      const qs = query({ _pl: pl, Entity: collection, ...extra });
      const src = await post(`/WSCView/List${qs}`, { containerId: "rtkt-probe-" + Math.random().toString(36).slice(2, 8) }, "text");
      const cfg = parseListConfig(src);
      cfg.size = src.length;
      return cfg;
    },

    /** Colonne scelte di un'entità. columns = espressioni ("Text", "User.FullName", …) */
    async projection(entity, conditions, columns, limit = 100, signal) {
      const names = columns.map((c) => c.replace(/[^A-Za-z0-9_]/g, "_"));
      const data = await post(
        `/WSC/Projection?_pl=${pl}`,
        { entity, filter: conditions, columnNames: names, columnExpressions: columns, limit },
        "json",
        signal,
      );
      const rows = Array.isArray(data.data) ? data.data : [];
      // righe con le chiavi = espressioni originali
      return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[names[i]] ?? r[c] ?? null])));
    },

    async getObject(collection, id) {
      const data = await get(`/WSCView/GetObjectAndDescription/${encodeURIComponent(id)}${query({ _pl: pl, entity: collection, _dc: Date.now() })}`);
      return data.data || null;
    },

    async staticList(entity, limit = 500) {
      const data = await get(`/WSCView/GetStaticList${query({ _pl: pl, entity, page: 1, start: 0, limit })}`);
      return Array.isArray(data.data) ? data.data : [];
    },

    /** Da verificare: lettura completa di un oggetto (quella che usa il dettaglio di Touch) */
    async wscGet(entity, id) {
      const data = await post(`/WSC/Get/${encodeURIComponent(entity)}/${encodeURIComponent(id)}?_pl=${pl}`, {});
      const d = data && (data.data || data);
      if (!d || typeof d !== "object") throw new HdaError("Risposta vuota da WSC/Get");
      return d;
    },

    /** Ricerca per le caselle con suggerimenti (formato del parametro di testo da verificare) */
    async objectSearch(collection, { text = "", searchFieldName = "", filter = [], limit = 25 } = {}) {
      const data = await get(`/WSCView/ObjectSearch${query({ _pl: pl, entity: collection, _dc: Date.now(), filter, searchFieldName, query: text, limit })}`);
      return Array.isArray(data.data) ? data.data : [];
    },

    async runAnalysis(analysisID, parameters) {
      const data = await post(`/WSC/RunAnalysis?_pl=${pl}`, { analysisID, parameters });
      return Array.isArray(data.data) ? data.data : [];
    },

    /**
     * Elenco di tutti gli allegati di un ticket (sia su Incident sia sui messaggi TicketConversationItem,
     * grazie a extKey="EXTEND_TICKET_ATTACHMENT" verificato sulle richieste reali di Touch).
     */
    async listAttachments(ticketId, signal) {
      if (!ticketId) return [];
      const conditions = [
        {
          property: "ParentObjectID",
          value: String(ticketId),
          op: "eq",
          lock: false,
          extKey: "EXTEND_TICKET_ATTACHMENT",
          description: null,
          parameterControlId: null,
        },
      ];
      const { rows } = await this.listData("Attachments", {
        viewId: "Default",
        conditions,
        page: 1,
        start: 0,
        limit: 100,
        sort: [{ property: "c5", direction: "DESC" }],
        signal,
      });
      return rows;
    },

    /** Legge il ContentType di un allegato (GET /WSCView/GetAttachmentContentType/<id>). */
    async getAttachmentContentType(id, { parentObject = "Incident", parentObjectId = "", signal } = {}) {
      const qs = query({
        _pl: pl,
        ParentObjectEntity: parentObject || "Incident",
        ParentObjectID: parentObjectId || "",
        UniqueID: "",
        _dc: Date.now(),
      });
      const data = await get(`/WSCView/GetAttachmentContentType/${encodeURIComponent(id)}${qs}`, signal);
      return (data && data.data && data.data.contentType) || "";
    },

    /**
     * Scarica il contenuto (in Base64) e i metadati di un allegato tramite POST /WSCView/PreviewAttachment
     * (lo stesso endpoint usato da HDA TOUCH sia per l'anteprima sia per il pulsante Download).
     */
    async previewAttachment(id, { parentObject = "Incident", parentObjectId = "", contentType = "", fileName = "", signal } = {}) {
      let mime = contentType || "";
      if (!mime) {
        try {
          mime = await this.getAttachmentContentType(id, { parentObject, parentObjectId, signal });
        } catch {
          mime = guessMimeFromName(fileName);
        }
      }
      const raw = await post(
        `/WSCView/PreviewAttachment?_pl=${pl}`,
        {
          ID: id,
          ParentObjectEntity: parentObject || "Incident",
          ParentObjectID: parentObjectId || "",
          UniqueID: "",
          ContentType: mime || "application/octet-stream",
          containerId: "window-3813",
          openingMode: "window",
          detailMode: "window",
        },
        "text",
        signal,
      );
      return parsePreviewAttachmentResponse(raw, { contentType: mime, fileName });
    },
  };
}

export function guessMimeFromName(name = "") {
  const lower = String(name || "").toLowerCase().trim();
  if (/\.pdf$/.test(lower)) return "application/pdf";
  if (/\.(xlsx|xlsm)$/.test(lower)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (/\.xls$/.test(lower)) return "application/vnd.ms-excel";
  if (/\.csv$/.test(lower)) return "text/csv";
  if (/\.docx$/.test(lower)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (/\.doc$/.test(lower)) return "application/msword";
  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg|tif|tiff)$/.test(lower)) {
    const ext = lower.split(".").pop();
    if (ext === "svg") return "image/svg+xml";
    if (ext === "jpg") return "image/jpeg";
    if (ext === "tif") return "image/tiff";
    return `image/${ext}`;
  }
  if (/\.html?$/.test(lower)) return "text/html";
  if (/\.json$/.test(lower)) return "application/json";
  if (/\.xml$/.test(lower)) return "application/xml";
  if (/\.(txt|log|md|yaml|yml|ini|cfg|sql|properties|inf|rpt)$/.test(lower)) return "text/plain";
  if (/\.(mp4|webm|ogg)$/.test(lower)) return `video/${lower.split(".").pop()}`;
  if (/\.avi$/.test(lower)) return "video/x-msvideo";
  if (/\.zip$/.test(lower)) return "application/zip";
  return "application/octet-stream";
}

/**
 * Estrae `{ content, contentType, fileName }` dalla risposta JS Ext.NET di `/WSCView/PreviewAttachment`
 * (`{"ConfigurationHolder":true,"model":"{\"contentType\":\"...\",\"content\":\"<base64>\",\"fileName\":\"...\"}"}`).
 */
export function parsePreviewAttachmentResponse(raw, fallback = {}) {
  if (!raw) throw new HdaError("Risposta vuota dal portale per l'allegato");
  if (typeof raw === "object" && raw.content) {
    const fn = raw.fileName || fallback.fileName || "allegato";
    return {
      content: String(raw.content),
      contentType: raw.contentType || fallback.contentType || guessMimeFromName(fn),
      fileName: fn,
    };
  }
  const s = String(raw);
  const m = /"model"\s*:\s*("(?:\\.|[^"\\])*")/.exec(s);
  if (m) {
    try {
      const inner = JSON.parse(m[1]);
      const obj = typeof inner === "string" ? JSON.parse(inner) : inner;
      if (obj && obj.content) {
        const fn = obj.fileName || fallback.fileName || "allegato";
        return {
          content: String(obj.content),
          contentType: obj.contentType || fallback.contentType || guessMimeFromName(fn),
          fileName: fn,
        };
      }
    } catch {
      /* continua */
    }
  }
  if (s.trim().startsWith("{")) {
    try {
      const j = JSON.parse(s);
      const d = j.data || j;
      if (d && d.content) {
        const fn = d.fileName || fallback.fileName || "allegato";
        return {
          content: String(d.content),
          contentType: d.contentType || fallback.contentType || guessMimeFromName(fn),
          fileName: fn,
        };
      }
    } catch {
      /* continua */
    }
  }
  throw new HdaError("Contenuto dell'allegato non disponibile nella risposta del portale");
}
