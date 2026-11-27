// Lettore: Ticket (Touch / Vecchio Cruscotto / Storico), Knowledge Base (HD Touch) e FAQ (HD Touch).

import { h, clear, icon, highlight, toast } from "./dom.js";
import { fmtDateTime, fmtDate, ticketNumber, tokens, isLegacyTicketNumber, sleep, debounce } from "../lib/util.js";
import { statusInfo } from "../lib/statuses.js";
import { sanitizeHtml, textToFragment, splitQuoted, htmlToText } from "../lib/richtext.js";
import { timelineText, formatTicketTxt, ticketTxtFilename } from "../lib/ticket.js";
import { highlightPatterns } from "../lib/relevance.js";
import { guessMimeFromName } from "../lib/hda.js";
import { kbLabel, isKbId, kbStatusInfo, kbNumericId } from "../lib/kb.js";
import { faqLabel, isFaqId, faqStatusInfo, faqNumericId } from "../lib/faq.js";

const isKbRow = (id, row, full) => ((full && full.source) || (row && row.source)) === "kb" || isKbId(id);
const isFaqRow = (id, row, full) => ((full && full.source) || (row && row.source)) === "faq" || isFaqId(id);
const shownNumber = (id, row, full) =>
  isKbRow(id, row, full)
    ? kbLabel(row && (row.code || row.kbId) ? row : { id })
    : isFaqRow(id, row, full)
      ? faqLabel(row && (row.code || row.faqId) ? row : { id })
      : ticketNumber(id);

const ROLE_LABEL = { customer: "Cliente", operator: "Operatore", system: "Sistema" };

// Cache in memoria degli allegati già scaricati nella sessione
const attCache = new Map();
let activePreviewUrl = null;
let previewSeq = 0;

const isWebUrl = (u) => /^https?:\/\//i.test(String(u || ""));

function revokePreviewUrl() {
  if (activePreviewUrl) {
    try {
      URL.revokeObjectURL(activePreviewUrl);
    } catch {
      /* */
    }
    activePreviewUrl = null;
  }
}

function b64ToBytes(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(b / (1024 * 1024)).toFixed(2).replace(".", ",")} MB`;
}

function fileExtLabel(att) {
  const name = String((att && att.fileName) || "").trim();
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(name);
  if (m) return m[1].toUpperCase();
  const ct = String((att && att.contentType) || "").toLowerCase();
  if (ct.includes("pdf")) return "PDF";
  if (ct.includes("image/")) return "IMG";
  if (ct.includes("csv")) return "CSV";
  if (ct.includes("excel") || ct.includes("spreadsheet")) return "XLS";
  if (ct.includes("word")) return "DOC";
  if (ct.includes("text/")) return "TXT";
  return "FILE";
}

function fileExtClass(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === "pdf") return "ext-pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff", "img"].includes(e)) return "ext-img";
  if (["xls", "xlsx", "xlsm", "csv"].includes(e)) return "ext-xls";
  if (["zip", "rar", "7z", "tar", "gz", "tgz"].includes(e)) return "ext-zip";
  if (["doc", "docx", "odt", "rtf"].includes(e)) return "ext-doc";
  return "ext-gen";
}

async function fetchAttachmentData(ctx, att, parentId) {
  const cacheKey = `${parentId || ""}:${att.id}`;
  if (attCache.has(cacheKey)) return attCache.get(cacheKey);
  let bytes;
  let fileName;
  let contentType;
  if (att.arPath) {
    if (!ctx || !ctx.ar || typeof ctx.ar.requestBinary !== "function") {
      throw new Error("Connessione all'Area Riservata non disponibile per aprire l'allegato");
    }
    const res = await ctx.ar.requestBinary(att.arPath, { fileName: att.fileName || "" });
    bytes = res.bytes;
    fileName = res.fileName || att.fileName || `${att.id}.bin`;
    const ct = String(res.contentType || "").trim();
    contentType = ct && ct !== "application/octet-stream" ? ct : att.contentType || guessMimeFromName(fileName);
  } else {
    if (!ctx || !ctx.hda || typeof ctx.hda.previewAttachment !== "function") {
      throw new Error("Connessione a HDA TOUCH non disponibile per scaricare l'allegato");
    }
    const res = await ctx.hda.previewAttachment(att.id, {
      parentObject: att.parentObject || "Incident",
      parentObjectId: att.parentObjectId || parentId || "",
      contentType: att.contentType || "",
      fileName: att.fileName || "",
    });
    bytes = b64ToBytes(res.content);
    fileName = res.fileName || att.fileName || `${att.id}.bin`;
    contentType = res.contentType || att.contentType || guessMimeFromName(fileName);
  }
  const item = { bytes, fileName, contentType };
  if (attCache.size >= 12) {
    const oldest = attCache.keys().next().value;
    if (oldest) attCache.delete(oldest);
  }
  attCache.set(cacheKey, item);
  return item;
}

function triggerBlobDownload(bytes, fileName, contentType) {
  const blob = new Blob([bytes], { type: contentType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName || "allegato";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* */
    }
  }, 45000);
}

function exportTicketTxt(full) {
  const txt = formatTicketTxt(full);
  const bytes = new TextEncoder().encode("\uFEFF" + txt.replace(/\r?\n/g, "\r\n"));
  const name = ticketTxtFilename(full);
  triggerBlobDownload(bytes, name, "text/plain;charset=utf-8");
  toast(`Esportato: ${name}`, "ok", 2200);
}

async function downloadAttachment(ctx, att, parentId, btn = null) {
  if (!att) return;
  if (att.url) {
    if (isWebUrl(att.url)) window.open(att.url, "_blank", "noopener");
    return;
  }
  const origDisabled = btn ? btn.disabled : false;
  if (btn) btn.disabled = true;
  try {
    const data = await fetchAttachmentData(ctx, att, parentId);
    triggerBlobDownload(data.bytes, data.fileName, data.contentType);
    toast(`Scaricato: ${data.fileName}`, "ok", 2200);
  } catch (e) {
    ctx.log && ctx.log(`allegato ${att.id}: ${e.message}`);
    toast(`Errore scaricamento allegato: ${e.message}`, "err", 4000);
  } finally {
    if (btn) btn.disabled = origDisabled;
  }
}

async function downloadAllAttachments(ctx, attachments, parentId, btn = null) {
  if (!attachments || !attachments.length) return;
  if (btn) btn.disabled = true;
  try {
    for (let i = 0; i < attachments.length; i++) {
      await downloadAttachment(ctx, attachments[i], parentId);
      if (i + 1 < attachments.length) await sleep(180);
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function parseCsvPreview(text, maxRows = 250) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return null;
  const first = lines[0];
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  for (let i = 0; i < Math.min(lines.length, maxRows); i++) {
    const line = lines[i];
    const cells = [];
    let cur = "";
    let inQ = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"') {
        if (inQ && line[c + 1] === '"') {
          cur += '"';
          c++;
        } else {
          inQ = !inQ;
        }
      } else if (ch === sep && !inQ) {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return { rows, totalLines: lines.length };
}

async function openAttachmentPreview(ctx, att, parentId) {
  if (!att) return;
  if (att.url) {
    if (isWebUrl(att.url)) window.open(att.url, "_blank", "noopener");
    return;
  }
  const my = ++previewSeq;
  const dlg = document.getElementById("attDlg");
  if (!dlg) {
    await downloadAttachment(ctx, att, parentId);
    return;
  }
  revokePreviewUrl();
  clear(dlg);

  const ext = fileExtLabel(att);
  const sizeSpan = h("span", { class: "hint" });
  const openTabBtn = h("button", { class: "btn btn-small", hidden: true, title: "Apri il file in una nuova scheda" }, icon("external"), "Apri in scheda");
  const dlBtn = h("button", { class: "btn btn-small btn-primary", onclick: () => downloadAttachment(ctx, att, parentId, dlBtn) }, icon("download"), "Scarica");
  const closeBtn = h("button", { class: "btn btn-icon", title: "Chiudi (Esc)", onclick: () => { revokePreviewUrl(); dlg.close(); } }, icon("close"));
  const viewer = h("div", { class: "dlg-b att-viewer" }, h("div", { class: "loading" }, h("span", { class: "spinner" }), `Carico ${att.fileName || "allegato"}…`));

  dlg.appendChild(
    h("div", { class: "dlg-h att-dlg-h" },
      h("span", { class: `att-ext ${fileExtClass(ext)}` }, ext),
      h("h2", { class: "att-dlg-title", title: att.fileName || "" }, att.fileName || att.id),
      sizeSpan,
      h("div", { class: "att-dlg-actions" }, openTabBtn, dlBtn, closeBtn)));
  dlg.appendChild(viewer);
  dlg.onclose = () => revokePreviewUrl();
  if (!dlg.open) dlg.showModal();

  try {
    const data = await fetchAttachmentData(ctx, att, parentId);
    if (my !== previewSeq || !dlg.open) return;
    sizeSpan.textContent = fmtBytes(data.bytes.byteLength);
    clear(viewer);

    const mime = String(data.contentType || guessMimeFromName(data.fileName)).toLowerCase();
    const fname = String(data.fileName || "").toLowerCase();
    const isPdf = mime === "application/pdf" || fname.endsWith(".pdf");
    const isImage = mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(fname);
    const isCsv = mime === "text/csv" || fname.endsWith(".csv");
    const isHtml = mime === "text/html" || /\.html?$/.test(fname);
    const isText = mime.startsWith("text/") || /json|xml|yaml|yml/.test(mime) || /\.(txt|log|xml|json|sql|ini|cfg|md|properties|inf|rpt)$/.test(fname);
    const isVideo = ["video/mp4", "video/webm", "video/ogg"].includes(mime) || /\.(mp4|webm|ogg)$/.test(fname);

    const isActive = isHtml || /svg/.test(mime) || fname.endsWith(".svg");
    const blobType = isPdf ? "application/pdf" : isActive ? "text/plain" : data.contentType || "application/octet-stream";
    const url = URL.createObjectURL(new Blob([data.bytes], { type: blobType }));
    activePreviewUrl = url;
    openTabBtn.hidden = false;
    openTabBtn.onclick = () => window.open(url, "_blank", "noopener");

    if (isPdf) {
      viewer.appendChild(h("iframe", { class: "att-frame", src: activePreviewUrl, title: data.fileName || "Anteprima PDF" }));
    } else if (isImage) {
      viewer.appendChild(h("div", { class: "att-img-wrap" }, h("img", { class: "att-img", src: activePreviewUrl, alt: data.fileName || "Immagine allegata" })));
    } else if (isCsv) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(data.bytes);
      const parsed = parseCsvPreview(text, 250);
      if (parsed && parsed.rows.length) {
        const [headRow, ...bodyRows] = parsed.rows;
        viewer.appendChild(
          h("div", { class: "att-table-wrap" },
            h("table", { class: "att-table" },
              h("thead", null, h("tr", null, headRow.map((c) => h("th", null, c)))),
              h("tbody", null, bodyRows.map((r) => h("tr", null, r.map((c) => h("td", null, c)))))),
            parsed.totalLines > parsed.rows.length
              ? h("div", { class: "hint", style: { padding: "8px 0" } }, `Mostrate le prime ${parsed.rows.length} righe su ${parsed.totalLines}. Scarica il file per aprirlo completo.`)
              : null));
      } else {
        viewer.appendChild(h("pre", { class: "att-pre" }, text));
      }
    } else if (isHtml) {
      const html = new TextDecoder("utf-8", { fatal: false }).decode(data.bytes);
      viewer.appendChild(h("div", { class: "att-html" }, sanitizeHtml(html)));
    } else if (isText) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(data.bytes);
      const copyBtn = h("button", { class: "btn btn-small", style: { justifySelf: "start" }, onclick: () => { navigator.clipboard.writeText(text); toast("Testo dell'allegato copiato", "ok", 1800); } }, icon("copy"), "Copia testo");
      viewer.appendChild(h("div", { class: "att-text-wrap" }, copyBtn, h("pre", { class: "att-pre" }, text)));
    } else if (isVideo) {
      viewer.appendChild(h("video", { class: "att-video", controls: true, preload: "metadata", src: activePreviewUrl }));
    } else {
      viewer.appendChild(
        h("div", { class: "att-binary" },
          h("span", { class: `att-ext ${fileExtClass(ext)}`, style: { fontSize: "15px", padding: "6px 12px" } }, ext),
          h("h3", null, data.fileName),
          h("div", { class: "hint" }, `Formato ${data.contentType || "binario"} · ${fmtBytes(data.bytes.byteLength)}`),
          h("button", { class: "btn btn-primary", style: { marginTop: "10px" }, onclick: () => triggerBlobDownload(data.bytes, data.fileName, data.contentType) }, icon("download"), "Scarica sul computer")));
    }
  } catch (e) {
    ctx.log && ctx.log(`anteprima allegato ${att.id}: ${e.message}`);
    if (my !== previewSeq) return;
    clear(viewer);
    viewer.appendChild(
      h("div", { class: "err-box" },
        "Impossibile caricare l'anteprima dell'allegato: " + e.message,
        h("div", { style: { display: "flex", gap: "8px", marginTop: "8px" } },
          h("button", { class: "btn", onclick: () => openAttachmentPreview(ctx, att, parentId) }, "Riprova"))));
  }
}

function ticketExportSection(full) {
  const entries = (full && full.timeline) || [];
  const nTotal = entries.length;
  const nInternal = entries.filter((e) => e && (e.internal || e.secondLevel)).length;
  const detail = nTotal
    ? `${nTotal} scamb${nTotal === 1 ? "io" : "i"} in ordine cronologico${
        nInternal
          ? ` · inclus${nInternal === 1 ? "a 1 nota interna / 2° livello" : `e ${nInternal} note interne / 2° livello`}`
          : " · incluse note interne e 2° livello"
      }`
    : "Storia completa del ticket in formato testo (.txt)";
  return h("section", { class: "export-bar", "aria-label": "Estrazione completa del ticket" },
    h("div", { class: "export-bar-info" },
      h("span", { class: "export-bar-title" }, icon("fileText"), "Storia completa (.txt)"),
      h("span", { class: "export-bar-meta" }, detail)),
    h("button", {
      type: "button",
      id: "exportTxtBtn",
      class: "btn btn-small btn-primary",
      title: "Scarica il file .txt con tutta la storia del ticket in ordine cronologico (incluse note interne e scambi con 2° livello)",
      onclick: () => exportTicketTxt(full),
    }, icon("download"), "Esporta storia (.txt)"));
}

function attachmentsSection(ctx, attachments, parentId) {
  if (!attachments || !attachments.length) return null;
  const dlAllBtn =
    attachments.length > 1
      ? h("button", { class: "btn btn-small", title: "Scarica tutti gli allegati", onclick: () => downloadAllAttachments(ctx, attachments, parentId, dlAllBtn) }, icon("download"), `Scarica tutti (${attachments.length})`)
      : null;

  return h("section", { class: "att-box", "aria-label": "Allegati" },
    h("div", { class: "att-head" },
      h("span", { class: "att-head-title" }, icon("clip"), `Allegati (${attachments.length})`),
      dlAllBtn),
    h("div", { class: "att-list" },
      attachments.map((att) => {
        const ext = fileExtLabel(att);
        const sizeLbl = att.sizeKb ? `${att.sizeKb.toFixed(1).replace(".", ",")} KB` : "";
        const meta = [sizeLbl, att.author, att.date ? fmtDateTime(att.date) : ""].filter(Boolean).join(" · ");
        const dlBtn = h("button", { class: "btn btn-small", title: "Scarica il file sul computer", onclick: (ev) => { ev.stopPropagation(); downloadAttachment(ctx, att, parentId, dlBtn); } }, icon("download"), "Scarica");
        return h("div", { class: "att-item" },
          h("span", { class: `att-ext ${fileExtClass(ext)}` }, ext),
          h("div", { class: "att-info", title: "Clicca per visualizzare l'anteprima", onclick: () => openAttachmentPreview(ctx, att, parentId) },
            h("div", { class: "att-name" }, att.fileName || att.id),
            meta || att.description ? h("div", { class: "att-meta" }, [att.description, meta].filter(Boolean).join(" — ")) : null),
          h("div", { class: "att-actions" },
            h("button", { class: "btn btn-small", title: "Visualizza l'allegato", onclick: () => openAttachmentPreview(ctx, att, parentId) }, icon("eye"), "Visualizza"),
            dlBtn));
      })));
}

function pill(statusId, text) {
  const s = statusInfo(statusId, text);
  return h("span", { class: `pill ${s.group}`, title: statusId || "" }, s.label);
}

export function renderReaderLoading(ctx, id, row) {
  const el = document.getElementById("reader");
  el.hidden = false;
  clear(el);
  el.appendChild(header(ctx, id, row, null));
  const kb = isKbRow(id, row, null);
  const faq = isFaqRow(id, row, null);
  const body = h("div", { class: "rd-body" },
    row ? (kb ? kbFacts(row) : faq ? faqFacts(row) : facts(row, null)) : null,
    h("div", { class: "loading" }, h("span", { class: "spinner" }), kb ? "Carico l'articolo Knowledge Base…" : faq ? "Carico la FAQ completa…" : "Carico la conversazione completa…"));
  el.appendChild(body);
  el.scrollTop = 0;
}

export function renderReaderError(ctx, id, row, err) {
  const el = document.getElementById("reader");
  const body = el.querySelector(".rd-body") || el.appendChild(h("div", { class: "rd-body" }));
  const ld = body.querySelector(".loading");
  if (ld) ld.remove();
  const kb = isKbRow(id, row, null);
  const faq = isFaqRow(id, row, null);
  const isLegacy = !kb && !faq && ((err && err.isLegacyTicket) || (row && (row.source === "ar" || row.source === "storico")) || (isLegacyTicketNumber(id) && !(row && row.source !== "ar" && row.id)));
  const num = ticketNumber(id);
  body.appendChild(
    h("div", { class: "err-box" },
      (kb ? "Non riesco a leggere l'articolo KB: " : faq ? "Non riesco a leggere la FAQ: " : "Non riesco a leggere il ticket: ") + err.message,
      h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "10px" } },
        isLegacy && ctx.openArHome
          ? h("button", { class: "btn btn-primary", onclick: () => ctx.openArHome(row && row.arUrl) }, icon("external"), "Apri e collega Vecchio Cruscotto")
          : null,
        isLegacy && ctx.searchLegacyRefInTouch
          ? h("button", { class: "btn", onclick: () => ctx.searchLegacyRefInTouch(num) }, `Cerca #${num} nei ticket Touch`)
          : null,
        h("button", { class: "btn", onclick: () => ctx.openTicket(id, row, { force: true }) }, "Riprova"))));
}

function header(ctx, id, row, full) {
  const fav = ctx.isFavorite(id);
  const source = (full && full.source) || (row && row.source) || (isKbId(id) ? "kb" : isFaqId(id) ? "faq" : "touch");
  const isStorico = source === "storico";
  const isKb = source === "kb";
  const isFaq = source === "faq";
  const isAr = source === "ar" || isStorico;
  const num = shownNumber(id, row, full);
  const t = (full && full.ticket) || {};
  const subject = (row && row.subject) || t.Subject || "";
  const statusId = (row && row.statusId) || t.TicketStatusID || "";

  const copyText = () => {
    const entries = (full.timeline || []).filter((e) => ctx.ui.showInternal || !e.internal);
    const kindLbl = isKb ? "Articolo KB" : isFaq ? "FAQ" : "Ticket";
    navigator.clipboard.writeText(timelineText(entries, `${kindLbl} ${num}${subject ? " — " + subject : ""}`));
    toast(isKb ? "Articolo copiato negli appunti" : isFaq ? "FAQ copiata negli appunti" : ctx.ui.showInternal ? "Ticket copiato negli appunti" : "Ticket copiato negli appunti (senza note interne)", "ok", 1800);
  };
  const arUrl = (full && full.arUrl) || (row && row.arUrl) || "";
  const favBtn = h("button", { class: "btn btn-icon" + (fav ? " star-on" : ""), title: fav ? "Togli dai preferiti" : "Aggiungi ai preferiti", onclick: () => { ctx.toggleFavorite(id, row); favBtn.classList.toggle("star-on"); } }, icon("star"));

  let statusPill = null;
  if (isKb) {
    const st = kbStatusInfo(row && row.statusId, row && row.statusText);
    statusPill = h("span", { class: `pill ${st.tone}` }, st.label);
  } else if (isFaq) {
    const st = faqStatusInfo(row && row.statusId, row && row.statusText);
    statusPill = h("span", { class: `pill ${st.tone}` }, st.label);
  } else if (statusId || (row && row.statusText)) {
    statusPill = pill(statusId, row && row.statusText);
  }

  const badgeText = isKb ? "Knowledge Base" : isFaq ? "FAQ" : isStorico ? "Ricerca avanzata" : isAr ? "Vecchio Cruscotto" : "HDA Touch";
  const badgeCls = isKb ? "kb" : isFaq ? "faq" : isStorico ? "storico" : isAr ? "ar" : "touch";

  const openPortalBtn = isAr
    ? h("button", { class: "btn", title: "Apri questo ticket nell'Area Riservata", onclick: () => ctx.openArHome && ctx.openArHome(arUrl) }, icon("external"), isStorico ? "Apri nell'Area Riservata" : "Apri nel vecchio cruscotto")
    : isKb
      ? h("button", { class: "btn", title: "Apri questo articolo in HDA TOUCH", onclick: () => ctx.openInTouch((row && row.kbId) || kbNumericId(id), "KBArticle", "CommKB") }, icon("external"), "Apri in Touch")
      : isFaq
        ? h("button", { class: "btn", title: "Apri questa FAQ in HDA TOUCH", onclick: () => ctx.openInTouch((row && row.faqId) || faqNumericId(id), "Faq") }, icon("external"), "Apri in Touch")
        : h("button", { class: "btn", title: "Apri questo ticket in HDA TOUCH", onclick: () => ctx.openInTouch(id, "Incident") }, icon("external"), "Apri in Touch");

  return h("div", { class: "rd-head" },
    h("div", { class: "rd-top" },
      h("span", { class: "rd-num", title: "Copia il codice/numero", onclick: () => { navigator.clipboard.writeText(num); toast("Copiato negli appunti", "ok", 1500); } }, (isKb || isFaq ? "" : "#") + num),
      statusPill,
      h("span", { class: `src-badge src-${badgeCls}` }, badgeText),
      row && row.typeText && source !== "ar" ? h("span", { class: "tag-mini" }, row.typeText) : null,
      h("div", { class: "rd-actions" },
        favBtn,
        full ? h("button", { class: "btn", title: "Copia come testo", onclick: copyText }, icon("copy"), "Copia") : null,
        ctx.openInNewPage && !ctx.S.solo
          ? h("button", { class: "btn", title: "Apri in una nuova pagina del browser", onclick: () => ctx.openInNewPage(id, (full && full.row) || row) }, icon("external"), "Nuova pagina")
          : null,
        openPortalBtn,
        h("button", { class: "btn btn-icon", title: ctx.S.solo ? "Chiudi questa pagina" : "Chiudi (Esc)", onclick: () => ctx.closeReader() }, icon("close")))),
    h("h1", { class: "rd-title" }, subject || (isKb ? "Articolo " : isFaq ? "FAQ " : "Ticket ") + num));
}

function facts(row, ticket, extraFacts = []) {
  const t = ticket || {};
  const F = [
    ["Cliente", [row.account, row.customerCode && !String(row.account || "").includes(row.customerCode) ? `(cod. ${row.customerCode})` : ""].filter(Boolean).join(" ")],
    ["Cliente originale", row.originalClient && row.originalClient !== row.account ? row.originalClient : ""],
    ["Contatto", [row.contact, t.TKMAILTO ? `‹${t.TKMAILTO}›` : ""].filter(Boolean).join(" ")],
    ["Gruppo owner", row.ownerGroup],
    ["Gruppo assegnato", row.assignedGroup && row.assignedGroup !== row.ownerGroup ? row.assignedGroup : ""],
    ["Assegnato a", row.assigned],
    ["Owner del ticket", row.ownerUser],
    ["Fornitore", row.supplier],
    ["Prodotto", t.CTITMDESC || row.catalog],
    ["Classificazione", row.classCli],
    ["Priorità", row.priorityText || (row.source === "storico" ? row.priority : "")],
    ["Aperto il", fmtDateTime(row.date || t.Date)],
    ["Ultimo aggiornamento", fmtDateTime(row.lastChange || t.LastChange)],
    ["Chiuso il", fmtDateTime(t.ClosureDate || row.closureDate)],
    ["Scadenza SLA", row.nextExpiration && statusInfo(row.statusId).group !== "closed" ? `${fmtDateTime(row.nextExpiration)}${row.sla ? " · " + row.sla : ""}` : ""],
    ...(extraFacts || []),
  ].filter(([, v]) => v && String(v).trim());
  return F.length ? h("dl", { class: "facts" }, F.map(([k, v]) => h("div", { class: "fact" }, h("dt", null, k), h("dd", null, v)))) : null;
}

function kbFacts(row, extraFacts = []) {
  const F = [
    ["Codice", row.code],
    ["Prodotto", row.catalog],
    ["Versione Prodotto", row.version],
    ["Argomento", row.topic],
    ["Tipo", row.typeText],
    ["Stato", row.statusText],
    ["Lingua", row.lang],
    ["Creato il", fmtDateTime(row.date)],
    ["Pubblicato il", fmtDate(row.publishDate)],
    ["Ultimo operatore", row.assigned],
    ...(extraFacts || []),
  ].filter(([, v]) => v && String(v).trim());
  return F.length ? h("dl", { class: "facts" }, F.map(([k, v]) => h("div", { class: "fact" }, h("dt", null, k), h("dd", null, v)))) : null;
}

function faqFacts(row, extraFacts = []) {
  const F = [
    ["Codice", row.code],
    ["Stato", row.statusText],
    ["Data creazione", fmtDateTime(row.date)],
    ["Data pubblicazione", fmtDateTime(row.publishDate)],
    ["Visibile dal", fmtDateTime(row.visibleFrom)],
    ["Visibile al", fmtDateTime(row.visibleTo)],
    ["Lingua", row.lang],
    ["Importanza", row.importance != null ? String(row.importance) : ""],
    ...(extraFacts || []),
  ].filter(([, v]) => v && String(v).trim());
  return F.length ? h("dl", { class: "facts" }, F.map(([k, v]) => h("div", { class: "fact" }, h("dt", null, k), h("dd", null, v)))) : null;
}

function bodyOf(entry) {
  const box = h("div", { class: "msg-b" });
  if (entry.html) {
    box.appendChild(sanitizeHtml(entry.html));
    return box;
  }
  const { main, quoted } = splitQuoted(entry.text);
  box.appendChild(textToFragment(main));
  if (quoted) {
    const q = h("div", { class: "quoted", hidden: true }, textToFragment(quoted));
    const btn = h("button", { class: "linkbtn quoted-toggle", onclick: () => { q.hidden = !q.hidden; btn.textContent = q.hidden ? "Mostra il testo citato" : "Nascondi il testo citato"; } }, "Mostra il testo citato");
    box.appendChild(btn);
    box.appendChild(q);
  }
  return box;
}

function messageAttachmentsEl(ctx, e, parentId, allAttachments) {
  const items =
    (e.attachmentItems && e.attachmentItems.length ? e.attachmentItems : null) ||
    (e.attachments && allAttachments && allAttachments.length === e.attachments ? allAttachments : null);
  if (items && items.length) {
    return h("div", { class: "msg-f msg-atts" },
      items.map((att) => {
        const dlBtn = h("button", { class: "att-chip-btn", title: `Scarica ${att.fileName || "allegato"}`, onclick: (ev) => { ev.stopPropagation(); downloadAttachment(ctx, att, parentId, dlBtn); } }, icon("download"));
        return h("div", { class: "att-chip" },
          h("button", { class: "att-chip-main", title: `Visualizza ${att.fileName || "allegato"}`, onclick: () => openAttachmentPreview(ctx, att, parentId) },
            icon("clip"),
            h("span", { class: "att-chip-name" }, att.fileName || att.id)),
          dlBtn);
      }));
  }
  if (e.attachments) {
    return h("div", { class: "msg-f" }, icon("clip"), `${e.attachments} allegat${e.attachments === 1 ? "o" : "i"} (vedi riquadro Allegati in alto)`);
  }
  return null;
}

function entryEl(ctx, e, parentId, allAttachments) {
  let cls = "msg " + (e.role || "operator");
  let role = ROLE_LABEL[e.role] || "Operatore";
  if (e.kind === "request") { cls += " request customer"; role = "Richiesta iniziale"; }
  if (e.kind === "question") { cls = "msg question"; role = e.author || "Domanda"; }
  if (e.kind === "solution") { cls = "msg solution"; role = "Soluzione"; }
  if (e.kind === "doc") { cls = "msg doc"; role = e.author || "Contenuto"; }
  if (e.internal) { cls += " internal"; role = e.secondLevel ? "Nota interna · 2° livello" : "Nota interna"; }
  const who = e.kind === "doc" || e.kind === "question" ? "" : e.author || (e.kind === "request" ? "Cliente" : "");
  const secondLvlTag = e.secondLevel
    ? typeof e.otherDept === "string" && e.otherDept.trim()
      ? e.otherDept.trim()
      : typeof e.remoteTicket === "string" && e.remoteTicket.trim()
        ? `2° livello · ${e.remoteTicket.trim()}`
        : "2° livello"
    : "";
  return h("article", { class: cls, dataset: { internal: e.internal ? "1" : "0" } },
    h("div", { class: "msg-card" },
      h("div", { class: "msg-h" },
        h("span", { class: "role" }, role),
        who ? h("span", { class: "who" }, who) : null,
        e.to ? h("span", { class: "hint" }, "→ " + e.to) : null,
        e.label ? h("span", { class: "tag-mini", title: "Causale del movimento" }, e.label) : null,
        e.account && e.account !== who ? h("span", { class: "hint" }, e.account) : null,
        secondLvlTag ? h("span", { class: "tag-mini", title: "Scambio con secondo livello / altro reparto" }, secondLvlTag) : null,
        e.internal ? h("span", { class: "tag-mini", title: "Non visibile al cliente" }, icon("lock"), " interna") : null,
        e.date ? h("span", { class: "at", title: e.date.toLocaleString("it-IT") }, fmtDateTime(e.date)) : null),
      bodyOf(e),
      e.truncated ? h("div", { class: "trunc" }, "Testo troncato dal portale: aprilo in Touch per leggerlo tutto.") : null,
      messageAttachmentsEl(ctx, e, parentId, allAttachments)));
}

export function renderReader(ctx, full, { fromArchive = null } = {}) {
  const el = document.getElementById("reader");
  el.hidden = false;
  const keepScroll = el.dataset.id === full.id ? el.scrollTop : 0;
  el.dataset.id = full.id;
  clear(el);
  const row = full.row || { id: full.id };
  const attachments = full.attachments || [];
  const isKb = isKbRow(full.id, row, full);
  const isFaq = isFaqRow(full.id, row, full);
  const parentId = isKb ? full.kbId || kbNumericId(full.id) : isFaq ? full.faqId || faqNumericId(full.id) : full.id;

  el.appendChild(header(ctx, full.id, row, full));

  const body = h("div", { class: "rd-body" });
  el.appendChild(body);
  const factsEl = isKb ? kbFacts(row, full.extraFacts) : isFaq ? faqFacts(row, full.extraFacts) : facts(row, full.ticket, full.extraFacts);
  if (factsEl) body.appendChild(factsEl);
  if (!isKb && !isFaq) body.appendChild(ticketExportSection(full));
  const attBox = attachmentsSection(ctx, attachments, parentId);
  if (attBox) body.appendChild(attBox);

  if (isKb && full.related && full.related.length) {
    body.appendChild(
      h("section", { class: "related-box" },
        h("h4", null, "Articoli KB correlati"),
        h("div", { class: "related-list" },
          full.related.map((rel) =>
            h("button", { class: "btn btn-small", onclick: () => ctx.openTicket(rel.id, { id: rel.id, kbId: rel.kbId, code: rel.code, subject: rel.title, source: "kb" }) },
              rel.code ? `${rel.code} · ${rel.title}` : rel.title)))));
  }

  if (fromArchive) body.appendChild(h("div", { class: "rd-note" }, `Copia salvata nell'archivio locale il ${fmtDate(fromArchive)}: il portale non ha risposto.`));
  for (const n of full.notes || []) body.appendChild(h("div", { class: "rd-note" }, n));

  const ui = ctx.ui;
  const entries = (full.timeline || []).slice();
  const nInternal = entries.filter((e) => e.internal).length;
  const nMsg = entries.filter((e) => e.kind === "message").length;
  const tl = h("div", { class: "timeline" });
  const search = h("input", { class: "input", type: "search", placeholder: isKb ? "Cerca nell'articolo…" : isFaq ? "Cerca nella FAQ…" : "Cerca nel ticket…", value: ui.readerSearch || "" });

  const activeQuery = isFaq
    ? [ctx.S.faqS.filters.query, ctx.S.faqS.filters.question, ctx.S.faqS.filters.answer].filter(Boolean).join(" ")
    : ctx.S.filters.text;

  function draw() {
    clear(tl);
    let list = entries.filter((e) => ui.showInternal || !e.internal);
    if (!isKb && !isFaq && ui.newestFirst) list = list.slice().reverse();
    if (!list.length) tl.appendChild(h("div", { class: "empty-state" }, "Nessun contenuto."));
    for (const e of list) tl.appendChild(entryEl(ctx, e, parentId, attachments));
    const words = tokens(search.value);
    const hits = highlight(tl, highlightPatterns(words.length ? words : tokens(activeQuery)));
    if (search.value.trim()) search.title = hits ? `${hits} occorrenze` : "Nessuna occorrenza";
  }
  const searchNow = debounce(() => {
    ui.readerSearch = search.value;
    draw();
    const marks = [...tl.querySelectorAll("mark")];
    const m = marks.find((x) => !x.closest("[hidden]")) || marks[0];
    if (m && search.value.trim()) {
      const q = m.closest("[hidden]");
      if (q) q.hidden = false;
      m.scrollIntoView({ block: "center" });
    }
  }, 200);
  search.addEventListener("input", searchNow);

  const btnInternal = h("button", { class: "btn btn-small" + (ui.showInternal ? " on" : ""), title: "Note visibili solo agli operatori", onclick: () => { ui.showInternal = !ui.showInternal; btnInternal.classList.toggle("on", ui.showInternal); ctx.saveUi(); draw(); } }, `Note interne (${nInternal})`);
  const btnOrder = h("button", { class: "btn btn-small", title: "Cambia l'ordine", onclick: () => { ui.newestFirst = !ui.newestFirst; btnOrder.textContent = ui.newestFirst ? "Dal più recente" : "Dal più vecchio"; ctx.saveUi(); draw(); } }, ui.newestFirst ? "Dal più recente" : "Dal più vecchio");

  body.appendChild(h("div", { class: "rd-tools" },
    h("h3", null, isKb ? "Contenuto articolo" : isFaq ? "Domanda e Risposta" : `Conversazione · ${nMsg} messaggi${entries.some((e) => e.kind === "solution") ? " + soluzione" : ""}`),
    nInternal ? btnInternal : null,
    isKb || isFaq ? null : btnOrder,
    search));
  body.appendChild(tl);
  draw();

  // numeri di ticket citati nel testo → si aprono qui
  tl.addEventListener("click", (ev) => {
    const a = ev.target.closest("a.rt-ticket");
    if (!a) return;
    ev.preventDefault();
    ctx.openTicket(a.dataset.ticket, null);
  });
  el.scrollTop = keepScroll;
}

export { htmlToText };
