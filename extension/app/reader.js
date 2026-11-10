// Lettore del ticket: intestazione, scheda dei dati, allegati (anteprima e scarico), timeline unica della conversazione.

import { h, clear, icon, highlight, toast } from "./dom.js";
import { fmtDateTime, fmtDate, ticketNumber, tokens, isLegacyTicketNumber, sleep, debounce } from "../lib/util.js";
import { statusInfo } from "../lib/statuses.js";
import { sanitizeHtml, textToFragment, splitQuoted, htmlToText } from "../lib/richtext.js";
import { timelineText } from "../lib/ticket.js";
import { guessMimeFromName } from "../lib/hda.js";

const ROLE_LABEL = { customer: "Cliente", operator: "Operatore", system: "Sistema" };

// Cache in memoria degli allegati già scaricati nella sessione (evita di riscaricare se si fa prima Visualizza e poi Scarica)
const attCache = new Map();
let activePreviewUrl = null;
let previewSeq = 0; // anteprima più recente: una risposta lenta di un'anteprima precedente viene scartata

/** Solo indirizzi web veri (gli allegati del Vecchio Cruscotto sono link alla sua pagina) */
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

async function fetchAttachmentData(ctx, att, ticketId) {
  const cacheKey = `${ticketId || ""}:${att.id}`;
  if (attCache.has(cacheKey)) return attCache.get(cacheKey);
  if (!ctx || !ctx.hda || typeof ctx.hda.previewAttachment !== "function") {
    throw new Error("Connessione a HDA TOUCH non disponibile per scaricare l'allegato");
  }
  const res = await ctx.hda.previewAttachment(att.id, {
    parentObject: att.parentObject || "Incident",
    parentObjectId: att.parentObjectId || ticketId || "",
    contentType: att.contentType || "",
    fileName: att.fileName || "",
  });
  const bytes = b64ToBytes(res.content);
  const fileName = res.fileName || att.fileName || `${att.id}.bin`;
  const contentType = res.contentType || att.contentType || guessMimeFromName(fileName);
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

async function downloadAttachment(ctx, att, ticketId, btn = null) {
  if (!att) return;
  if (att.url) {
    if (isWebUrl(att.url)) window.open(att.url, "_blank", "noopener");
    return;
  }
  const origDisabled = btn ? btn.disabled : false;
  if (btn) btn.disabled = true;
  try {
    const data = await fetchAttachmentData(ctx, att, ticketId);
    triggerBlobDownload(data.bytes, data.fileName, data.contentType);
    toast(`Scaricato: ${data.fileName}`, "ok", 2200);
  } catch (e) {
    ctx.log && ctx.log(`allegato ${att.id}: ${e.message}`);
    toast(`Errore scaricamento allegato: ${e.message}`, "err", 4000);
  } finally {
    if (btn) btn.disabled = origDisabled;
  }
}

async function downloadAllAttachments(ctx, attachments, ticketId, btn = null) {
  if (!attachments || !attachments.length) return;
  if (btn) btn.disabled = true;
  try {
    for (let i = 0; i < attachments.length; i++) {
      await downloadAttachment(ctx, attachments[i], ticketId);
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

async function openAttachmentPreview(ctx, att, ticketId) {
  if (!att) return;
  // allegato del Vecchio Cruscotto: è un link alla sua pagina, non un allegato di Touch
  if (att.url) {
    if (isWebUrl(att.url)) window.open(att.url, "_blank", "noopener");
    return;
  }
  const my = ++previewSeq;
  const dlg = document.getElementById("attDlg");
  if (!dlg) {
    await downloadAttachment(ctx, att, ticketId);
    return;
  }
  revokePreviewUrl();
  clear(dlg);

  const ext = fileExtLabel(att);
  const sizeSpan = h("span", { class: "hint" });
  const openTabBtn = h(
    "button",
    { class: "btn btn-small", hidden: true, title: "Apri il file a schermo intero in una nuova scheda" },
    icon("external"),
    "Apri in scheda",
  );
  const dlBtn = h(
    "button",
    { class: "btn btn-small btn-primary", onclick: () => downloadAttachment(ctx, att, ticketId, dlBtn) },
    icon("download"),
    "Scarica",
  );
  const closeBtn = h(
    "button",
    {
      class: "btn btn-icon",
      title: "Chiudi (Esc)",
      onclick: () => {
        revokePreviewUrl();
        dlg.close();
      },
    },
    icon("close"),
  );

  const viewer = h(
    "div",
    { class: "dlg-b att-viewer" },
    h("div", { class: "loading" }, h("span", { class: "spinner" }), `Carico ${att.fileName || "allegato"}…`),
  );

  dlg.appendChild(
    h(
      "div",
      { class: "dlg-h att-dlg-h" },
      h("span", { class: `att-ext ${fileExtClass(ext)}` }, ext),
      h("h2", { class: "att-dlg-title", title: att.fileName || "" }, att.fileName || att.id),
      sizeSpan,
      h("div", { class: "att-dlg-actions" }, openTabBtn, dlBtn, closeBtn),
    ),
  );
  dlg.appendChild(viewer);
  dlg.onclose = () => revokePreviewUrl();
  if (!dlg.open) dlg.showModal();

  try {
    const data = await fetchAttachmentData(ctx, att, ticketId);
    if (my !== previewSeq || !dlg.open) return; // nel frattempo è stata chiusa o aperta un'altra anteprima
    sizeSpan.textContent = fmtBytes(data.bytes.byteLength);
    clear(viewer);

    const mime = String(data.contentType || guessMimeFromName(data.fileName)).toLowerCase();
    const fname = String(data.fileName || "").toLowerCase();
    const isPdf = mime === "application/pdf" || fname.endsWith(".pdf");
    const isImage = mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(fname);
    const isCsv = mime === "text/csv" || fname.endsWith(".csv");
    const isHtml = mime === "text/html" || /\.html?$/.test(fname);
    const isText =
      mime.startsWith("text/") ||
      /json|xml|yaml|yml/.test(mime) ||
      /\.(txt|log|xml|json|sql|ini|cfg|md|properties|inf|rpt)$/.test(fname);
    const isVideo = ["video/mp4", "video/webm", "video/ogg"].includes(mime) || /\.(mp4|webm|ogg)$/.test(fname);

    // HTML e SVG si aprono come testo: un file allegato non deve poter eseguire script
    const isActive = isHtml || /svg/.test(mime) || fname.endsWith(".svg");
    const blobType = isPdf ? "application/pdf" : isActive ? "text/plain" : data.contentType || "application/octet-stream";
    const url = URL.createObjectURL(new Blob([data.bytes], { type: blobType }));
    activePreviewUrl = url;
    openTabBtn.hidden = false;
    openTabBtn.onclick = () => window.open(url, "_blank", "noopener");

    if (isPdf) {
      viewer.appendChild(
        h("iframe", {
          class: "att-frame",
          src: activePreviewUrl,
          title: data.fileName || "Anteprima PDF",
        }),
      );
    } else if (isImage) {
      viewer.appendChild(
        h(
          "div",
          { class: "att-img-wrap" },
          h("img", { class: "att-img", src: activePreviewUrl, alt: data.fileName || "Immagine allegata" }),
        ),
      );
    } else if (isCsv) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(data.bytes);
      const parsed = parseCsvPreview(text, 250);
      if (parsed && parsed.rows.length) {
        const [headRow, ...bodyRows] = parsed.rows;
        viewer.appendChild(
          h(
            "div",
            { class: "att-table-wrap" },
            h(
              "table",
              { class: "att-table" },
              h("thead", null, h("tr", null, headRow.map((c) => h("th", null, c)))),
              h("tbody", null, bodyRows.map((r) => h("tr", null, r.map((c) => h("td", null, c))))),
            ),
            parsed.totalLines > parsed.rows.length
              ? h("div", { class: "hint", style: { padding: "8px 0" } }, `Mostrate le prime ${parsed.rows.length} righe su ${parsed.totalLines}. Scarica il file per aprirlo completo in Excel.`)
              : null,
          ),
        );
      } else {
        viewer.appendChild(h("pre", { class: "att-pre" }, text));
      }
    } else if (isHtml) {
      const html = new TextDecoder("utf-8", { fatal: false }).decode(data.bytes);
      viewer.appendChild(h("div", { class: "att-html" }, sanitizeHtml(html)));
    } else if (isText) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(data.bytes);
      const copyBtn = h(
        "button",
        {
          class: "btn btn-small",
          style: { justifySelf: "start" },
          onclick: () => {
            navigator.clipboard.writeText(text);
            toast("Testo dell'allegato copiato", "ok", 1800);
          },
        },
        icon("copy"),
        "Copia testo",
      );
      viewer.appendChild(h("div", { class: "att-text-wrap" }, copyBtn, h("pre", { class: "att-pre" }, text)));
    } else if (isVideo) {
      viewer.appendChild(
        h("video", { class: "att-video", controls: true, preload: "metadata", src: activePreviewUrl }),
      );
    } else {
      viewer.appendChild(
        h(
          "div",
          { class: "att-binary" },
          h("span", { class: `att-ext ${fileExtClass(ext)}`, style: { fontSize: "15px", padding: "6px 12px" } }, ext),
          h("h3", null, data.fileName),
          h("div", { class: "hint" }, `Formato ${data.contentType || "binario"} · ${fmtBytes(data.bytes.byteLength)}`),
          h(
            "button",
            {
              class: "btn btn-primary",
              style: { marginTop: "10px" },
              onclick: () => triggerBlobDownload(data.bytes, data.fileName, data.contentType),
            },
            icon("download"),
            "Scarica sul computer",
          ),
        ),
      );
    }
  } catch (e) {
    ctx.log && ctx.log(`anteprima allegato ${att.id}: ${e.message}`);
    if (my !== previewSeq) return;
    clear(viewer);
    viewer.appendChild(
      h(
        "div",
        { class: "err-box" },
        "Impossibile caricare l'anteprima dell'allegato: " + e.message,
        h(
          "div",
          { style: { display: "flex", gap: "8px", marginTop: "8px" } },
          h("button", { class: "btn", onclick: () => openAttachmentPreview(ctx, att, ticketId) }, "Riprova"),
          h("button", { class: "btn", onclick: () => ctx.openInTouch && ctx.openInTouch(ticketId) }, icon("external"), "Apri ticket in Touch"),
        ),
      ),
    );
  }
}

function attachmentsSection(ctx, attachments, ticketId) {
  if (!attachments || !attachments.length) return null;
  const dlAllBtn =
    attachments.length > 1
      ? h(
          "button",
          {
            class: "btn btn-small",
            title: "Scarica tutti gli allegati di questo ticket",
            onclick: () => downloadAllAttachments(ctx, attachments, ticketId, dlAllBtn),
          },
          icon("download"),
          `Scarica tutti (${attachments.length})`,
        )
      : null;

  return h(
    "section",
    { class: "att-box", "aria-label": "Allegati del ticket" },
    h(
      "div",
      { class: "att-head" },
      h("span", { class: "att-head-title" }, icon("clip"), `Allegati (${attachments.length})`),
      dlAllBtn,
    ),
    h(
      "div",
      { class: "att-list" },
      attachments.map((att) => {
        const ext = fileExtLabel(att);
        const meta = [att.author, att.date ? fmtDateTime(att.date) : ""].filter(Boolean).join(" · ");
        const dlBtn = h(
          "button",
          {
            class: "btn btn-small",
            title: "Scarica il file sul computer",
            onclick: (ev) => {
              ev.stopPropagation();
              downloadAttachment(ctx, att, ticketId, dlBtn);
            },
          },
          icon("download"),
          "Scarica",
        );
        return h(
          "div",
          { class: "att-item" },
          h("span", { class: `att-ext ${fileExtClass(ext)}` }, ext),
          h(
            "div",
            {
              class: "att-info",
              title: "Clicca per visualizzare l'anteprima",
              onclick: () => openAttachmentPreview(ctx, att, ticketId),
            },
            h("div", { class: "att-name" }, att.fileName || att.id),
            meta || att.description
              ? h("div", { class: "att-meta" }, [att.description, meta].filter(Boolean).join(" — "))
              : null,
          ),
          h(
            "div",
            { class: "att-actions" },
            h(
              "button",
              {
                class: "btn btn-small",
                title: "Visualizza l'allegato",
                onclick: () => openAttachmentPreview(ctx, att, ticketId),
              },
              icon("eye"),
              "Visualizza",
            ),
            dlBtn,
          ),
        );
      }),
    ),
  );
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
  const body = h("div", { class: "rd-body" }, row ? facts(row, null) : null, h("div", { class: "loading" }, h("span", { class: "spinner" }), "Carico la conversazione completa…"));
  el.appendChild(body);
  el.scrollTop = 0;
}

export function renderReaderError(ctx, id, row, err) {
  const el = document.getElementById("reader");
  const body = el.querySelector(".rd-body") || el.appendChild(h("div", { class: "rd-body" }));
  const ld = body.querySelector(".loading");
  if (ld) ld.remove();
  const isLegacy = (err && err.isLegacyTicket) || (row && row.source === "ar") || (isLegacyTicketNumber(id) && !(row && row.source !== "ar" && row.id));
  const num = ticketNumber(id);
  body.appendChild(
    h("div", { class: "err-box" },
      "Non riesco a leggere il ticket: " + err.message,
      h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" } },
        isLegacy && ctx.openArHome
          ? h("button", { class: "btn btn-primary", onclick: () => ctx.openArHome(row && row.arUrl) }, icon("external"), "Apri e collega Vecchio Cruscotto")
          : null,
        isLegacy && ctx.searchLegacyRefInTouch
          ? h("button", { class: "btn", onclick: () => ctx.searchLegacyRefInTouch(num) }, `Cerca #${num} nei ticket Touch`)
          : null,
        h("button", { class: "btn", onclick: () => ctx.openTicket(id, row, { force: true }) }, "Riprova")))
  );
}

function header(ctx, id, row, full) {
  const fav = ctx.isFavorite(id);
  const isAr = (row && row.source === "ar") || (full && full.source === "ar");
  const t = (full && full.ticket) || {};
  const subject = (row && row.subject) || t.Subject || "";
  const statusId = (row && row.statusId) || t.TicketStatusID || "";
  // la copia segue il pulsante «Note interne»: le note nascoste non finiscono negli appunti (e magari in una mail al cliente)
  const copyText = () => {
    const entries = (full.timeline || []).filter((e) => ctx.ui.showInternal || !e.internal);
    navigator.clipboard.writeText(timelineText(entries, `Ticket ${ticketNumber(id)}${subject ? " — " + subject : ""}`));
    toast(ctx.ui.showInternal ? "Ticket copiato negli appunti" : "Ticket copiato negli appunti (senza note interne)", "ok", 1800);
  };
  const arUrl = (full && full.arUrl) || (row && row.arUrl) || "";
  const favBtn = h("button", { class: "btn btn-icon" + (fav ? " star-on" : ""), title: fav ? "Togli dai preferiti" : "Aggiungi ai preferiti", onclick: () => { ctx.toggleFavorite(id, row); favBtn.classList.toggle("star-on"); } }, icon("star"));
  return h("div", { class: "rd-head" },
    h("div", { class: "rd-top" },
      h("span", { class: "rd-num", title: "Copia il numero", onclick: () => { navigator.clipboard.writeText(ticketNumber(id)); toast("Numero copiato", "ok", 1500); } }, "#" + ticketNumber(id)),
      statusId || (row && row.statusText) ? pill(statusId, row && row.statusText) : null,
      isAr ? h("span", { class: "tag-mini src-ar", title: "Ticket del Vecchio Cruscotto (Area Riservata)" }, "Vecchio cruscotto") : null,
      row && row.typeText && !isAr ? h("span", { class: "tag-mini" }, row.typeText) : null,
      h("div", { class: "rd-actions" },
        favBtn,
        full ? h("button", { class: "btn", title: "Copia tutto il ticket come testo (le note interne solo se visibili)", onclick: copyText }, icon("copy"), "Copia") : null,
        isAr
          ? h("button", { class: "btn", title: "Apri questo ticket nel Vecchio Cruscotto (Area Riservata)", onclick: () => ctx.openArHome && ctx.openArHome(arUrl) }, icon("external"), "Apri nel vecchio cruscotto")
          : h("button", { class: "btn", title: "Apri questo ticket in HDA TOUCH", onclick: () => ctx.openInTouch(id) }, icon("external"), "Apri in Touch"),
        h("button", { class: "btn btn-icon", title: "Chiudi (Esc)", onclick: () => ctx.closeReader() }, icon("close")))),
    h("h1", { class: "rd-title" }, subject || "Ticket " + ticketNumber(id)));
}

function facts(row, ticket, extraFacts = []) {
  const t = ticket || {};
  const F = [
    ["Cliente", [row.account, row.customerCode ? `(cod. ${row.customerCode})` : ""].filter(Boolean).join(" ")],
    ["Contatto", [row.contact, t.TKMAILTO ? `‹${t.TKMAILTO}›` : ""].filter(Boolean).join(" ")],
    ["Gruppo", row.ownerGroup],
    ["Assegnato a", row.assigned],
    ["Responsabile", row.ownerUser],
    ["Prodotto", t.CTITMDESC || row.catalog],
    ["Classificazione", row.classCli],
    ["Priorità", row.priorityText],
    ["Aperto il", fmtDateTime(row.date || t.Date)],
    ["Ultimo aggiornamento", fmtDateTime(row.lastChange || t.LastChange)],
    ["Chiuso il", fmtDateTime(t.ClosureDate || row.closureDate)],
    ["Scadenza SLA", row.nextExpiration && statusInfo(row.statusId).group !== "closed" ? `${fmtDateTime(row.nextExpiration)}${row.sla ? " · " + row.sla : ""}` : ""],
    ...(extraFacts || []),
  ].filter(([, v]) => v && String(v).trim());
  return h("dl", { class: "facts" }, F.map(([k, v]) => h("div", { class: "fact" }, h("dt", null, k), h("dd", null, v))));
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

function messageAttachmentsEl(ctx, e, ticketId, allAttachments) {
  const items =
    (e.attachmentItems && e.attachmentItems.length ? e.attachmentItems : null) ||
    (e.attachments && allAttachments && allAttachments.length === e.attachments ? allAttachments : null);
  if (items && items.length) {
    return h(
      "div",
      { class: "msg-f msg-atts" },
      items.map((att) => {
        const dlBtn = h(
          "button",
          {
            class: "att-chip-btn",
            title: `Scarica ${att.fileName || "allegato"}`,
            onclick: (ev) => {
              ev.stopPropagation();
              downloadAttachment(ctx, att, ticketId, dlBtn);
            },
          },
          icon("download"),
        );
        return h(
          "div",
          { class: "att-chip" },
          h(
            "button",
            {
              class: "att-chip-main",
              title: `Visualizza ${att.fileName || "allegato"}`,
              onclick: () => openAttachmentPreview(ctx, att, ticketId),
            },
            icon("clip"),
            h("span", { class: "att-chip-name" }, att.fileName || att.id),
          ),
          dlBtn,
        );
      }),
    );
  }
  if (e.attachments) {
    return h(
      "div",
      { class: "msg-f" },
      icon("clip"),
      `${e.attachments} allegat${e.attachments === 1 ? "o" : "i"} (vedi riquadro Allegati in alto)`,
    );
  }
  return null;
}

function entryEl(ctx, e, ticketId, allAttachments) {
  let cls = "msg " + (e.role || "operator");
  let role = ROLE_LABEL[e.role] || "Operatore";
  if (e.kind === "request") { cls += " request customer"; role = "Richiesta iniziale"; }
  if (e.kind === "solution") { cls = "msg solution"; role = "Soluzione"; }
  if (e.internal) { cls += " internal"; role = "Nota interna"; }
  const who = e.author || (e.kind === "request" ? "Cliente" : "");
  return h("article", { class: cls, dataset: { internal: e.internal ? "1" : "0" } },
    h("div", { class: "msg-card" },
      h("div", { class: "msg-h" },
        h("span", { class: "role" }, role),
        who ? h("span", { class: "who" }, who) : null,
        e.role === "customer" && e.account && e.account !== who ? h("span", { class: "hint" }, e.account) : null,
        e.internal ? h("span", { class: "tag-mini", title: "Non visibile al cliente" }, icon("lock"), " interna") : null,
        h("span", { class: "at", title: e.date ? e.date.toLocaleString("it-IT") : "" }, fmtDateTime(e.date))),
      bodyOf(e),
      e.truncated ? h("div", { class: "trunc" }, "Testo troncato dal portale: aprilo in Touch per leggerlo tutto.") : null,
      messageAttachmentsEl(ctx, e, ticketId, allAttachments)));
}

export function renderReader(ctx, full, { fromArchive = null } = {}) {
  const el = document.getElementById("reader");
  el.hidden = false;
  const keepScroll = el.dataset.id === full.id ? el.scrollTop : 0;
  el.dataset.id = full.id;
  clear(el);
  const row = full.row || { id: full.id };
  const attachments = full.attachments || [];
  el.appendChild(header(ctx, full.id, row, full));

  const body = h("div", { class: "rd-body" });
  el.appendChild(body);
  body.appendChild(facts(row, full.ticket, full.extraFacts));
  const attBox = attachmentsSection(ctx, attachments, full.id);
  if (attBox) body.appendChild(attBox);
  if (fromArchive) body.appendChild(h("div", { class: "rd-note" }, `Copia salvata nell'archivio locale il ${fmtDate(fromArchive)}: il portale non ha risposto.`));
  for (const n of full.notes || []) body.appendChild(h("div", { class: "rd-note" }, n));

  const ui = ctx.ui;
  const entries = full.timeline.slice();
  const nInternal = entries.filter((e) => e.internal).length;
  const nMsg = entries.filter((e) => e.kind === "message").length;
  const tl = h("div", { class: "timeline" });
  const search = h("input", { class: "input", type: "search", placeholder: "Cerca nel ticket…", value: ui.readerSearch || "" });

  function draw() {
    clear(tl);
    let list = entries.filter((e) => ui.showInternal || !e.internal);
    if (ui.newestFirst) list = list.slice().reverse();
    if (!list.length) tl.appendChild(h("div", { class: "empty-state" }, "Nessun messaggio."));
    for (const e of list) tl.appendChild(entryEl(ctx, e, full.id, attachments));
    const words = tokens(search.value);
    const hits = highlight(tl, words.length ? words : tokens(ctx.S.filters.text));
    if (search.value.trim()) search.title = hits ? `${hits} occorrenze` : "Nessuna occorrenza";
  }
  // si ridisegna dopo una breve pausa (non a ogni tasto) e si apre il testo citato che contiene la parola trovata
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
    h("h3", null, `Conversazione · ${nMsg} messaggi${entries.some((e) => e.kind === "solution") ? " + soluzione" : ""}`),
    nInternal ? btnInternal : null,
    btnOrder,
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
