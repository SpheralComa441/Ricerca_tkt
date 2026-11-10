// Finestra "Diagnostica e impostazioni".
//  - Diagnostica: prova sul portale ogni funzione usata e prepara un rapporto senza dati personali;
//  - Filtri appresi: cosa l'estensione ha imparato osservando le ricerche fatte in Touch;
//  - Impostazioni, Archivio locale, Registro.

import { h, clear, icon, toast } from "./dom.js";
import { runProbe } from "../lib/probe.js";
import { FILTER_DEFS, ruleFor } from "../lib/filters.js";
import { clearArchive, kvSet } from "../lib/store.js";
import { isLegacyTicketNumber } from "../lib/util.js";

export function openDiag(ctx) {
  const dlg = document.getElementById("diag");
  clear(dlg);
  const body = h("div", { class: "dlg-b" });
  dlg.append(
    h("div", { class: "dlg-h" }, h("h2", null, "Diagnostica e impostazioni"), h("button", { class: "btn btn-icon", title: "Chiudi", onclick: () => dlg.close() }, icon("close"))),
    body,
  );
  let redrawLearned = () => {};
  let redrawLog = () => {};
  const learnedSec = learnedSection(ctx, (fn) => (redrawLearned = fn));
  const logSec = logSection(ctx, (fn) => (redrawLog = fn));
  body.append(probeSection(ctx, () => { redrawLearned(); redrawLog(); }), learnedSec, settingsSection(ctx), archiveSection(ctx), logSec);
  dlg.showModal();
}

function probeSection(ctx, onDone) {
  const steps = h("div", { class: "steps" });
  let report = null;
  const copyBtn = h("button", { class: "btn", disabled: true, onclick: () => { navigator.clipboard.writeText(JSON.stringify(report, null, 1)); toast("Rapporto copiato: incollalo nella chat", "ok"); } }, icon("copy"), "Copia rapporto");
  const runBtn = h("button", { class: "btn btn-primary", onclick: run }, "Avvia la diagnostica");

  function draw(list) {
    clear(steps);
    for (const s of list) {
      const done = s.ms != null;
      steps.appendChild(h("div", { class: "st" },
        h("span", { class: done ? (s.ok ? "ok" : "ko") : "" }, done ? (s.ok ? "✓" : "✗") : "…"),
        h("span", null, s.name),
        s.detail ? h("span", { class: "d" }, String(s.detail)) : null));
    }
  }

  async function run() {
    runBtn.disabled = true;
    copyBtn.disabled = true;
    try {
      const sampleTicketId =
        (ctx.S.current && !isLegacyTicketNumber(ctx.S.current) ? ctx.S.current : null) ||
        (ctx.S.sampleTicket && ctx.S.sampleTicket.id) ||
        null;
      const res = await runProbe(ctx.hda, { onStep: draw, sampleTicketId, learned: ctx.S.calib.learned, captures: ctx.S.captures, log: ctx.log });
      if (res.workingContains && res.workingContains.wildcard) {
        ctx.S.caps.containsText = res.workingContains;
        ctx.S.calib.containsText = res.workingContains;
      }
      if (res.workingFullText) {
        ctx.S.caps.fullTextRule = res.workingFullText;
        ctx.S.caps.fullTextBroken = null;
        ctx.S.calib.overrides = { ...(ctx.S.calib.overrides || {}), text: { ...res.workingFullText, source: "calibrato" } };
      }
      await kvSet("caps", ctx.S.caps);
      // la configurazione appena letta aggiorna subito colonne e filtri
      if (res.config && Object.keys(res.config.mapping || {}).length) await ctx.reloadCalibration(true);
      report = {
        ...res.report,
        transport: ctx.hda && ctx.S.connected ? "ok" : "non connesso",
        caps: ctx.S.caps,
        rules: Object.fromEntries(FILTER_DEFS.map((d) => { const r = ruleFor(d, ctx.S.calib); return [d.key, `${r.property} ${r.op}${r.wildcard ? " %…%" : ""}${r.extKey ? " [" + r.extKey + "]" : ""} (${r.source})`]; })),
        lookups: ctx.lookups ? ctx.lookups.sizes() : null,
      };
      copyBtn.disabled = false;
      onDone();
      const ko = res.steps.filter((s) => !s.ok).length;
      toast(ko ? `Diagnostica finita: ${ko} prove non riuscite` : "Diagnostica finita: tutto ok", ko ? "info" : "ok");
    } catch (e) {
      toast("Diagnostica interrotta: " + e.message, "err");
    } finally {
      runBtn.disabled = false;
      onDone();
    }
  }

  return h("section", null,
    h("h3", null, "Diagnostica"),
    h("p", { class: "hint" }, "Prova, solo in lettura, ogni servizio di Touch usato dall'estensione. Il rapporto contiene solo esiti, nomi di colonne e formati dei filtri: nessun nome di cliente, testo o numero di ticket. Se hai un ticket aperto viene usato come prova."),
    h("div", { style: { display: "flex", gap: "8px" } }, runBtn, copyBtn),
    steps);
}

function learnedSection(ctx, setRedraw) {
  const box = h("div", { class: "learned" });
  function draw() {
    clear(box);
    const L = ctx.S.calib.learned || {};
    const keys = Object.keys(L);
    for (const d of FILTER_DEFS) {
      const r = ruleFor(d, ctx.S.calib);
      box.appendChild(h("div", { class: "lrow" },
        h("div", null, h("b", null, d.label), " — ", h("code", null, `${r.property} ${r.op}${r.wildcard ? ' "%…%"' : ""}${r.extKey ? " [" + r.extKey + "]" : ""}`), " ",
          h("span", { class: r.source === "predefinito" ? "ko" : "ok", style: { fontSize: "11.5px" } }, r.source))));
    }
    const extra = keys.filter((k) => !FILTER_DEFS.some((d) => d.touchId === k));
    if (extra.length) box.appendChild(h("div", { class: "hint" }, "Altri filtri visti in Touch: " + extra.join(", ")));
  }
  draw();
  if (setRedraw) setRedraw(draw);
  return h("section", null,
    h("h3", null, "Filtri: come vengono inviati a Touch"),
    h("p", { class: "hint" }, "«predefinito» = formato ipotizzato. Per renderlo sicuro, apri Touch, usa quel filtro una volta nella lista ticket e l'estensione registra il formato esatto («appreso da Touch»)."),
    box,
    h("div", null, h("button", { class: "btn btn-small", onclick: async () => {
      if (!confirm("Dimenticare i filtri appresi e le ricerche registrate da Touch?")) return;
      ctx.S.calib.learned = {};
      ctx.S.captures = [];
      await kvSet("learned", {});
      await kvSet("captures", []);
      draw();
      toast("Filtri appresi azzerati", "ok");
    } }, "Dimentica i filtri appresi")));
}

function settingsSection(ctx) {
  const st = ctx.S.settings;
  const sel = (key, opts, label, hint) => {
    const s = h("select", { class: "input", style: { width: "100%" }, onchange: async () => { await ctx.saveSettings({ [key]: isNaN(+s.value) ? s.value : +s.value }); toast("Impostazione salvata", "ok", 1200); } },
      opts.map(([v, l]) => h("option", { value: v, selected: String(st[key]) === String(v) ? true : null }, l)));
    return h("div", { class: "field" }, h("label", null, label), s, hint ? h("div", { class: "hint" }, hint) : null);
  };
  const cb = h("input", { type: "checkbox", checked: st.archiveOnRead ? true : null, onchange: () => ctx.saveSettings({ archiveOnRead: cb.checked }) });
  return h("section", null,
    h("h3", null, "Impostazioni"),
    h("div", { class: "settings" },
      sel("pageSize", [[50, "50"], [100, "100"], [200, "200"]], "Ticket per pagina"),
      sel("archiveCap", [[100, "100"], [300, "300"], [1000, "1000"], [3000, "3000"]], "Massimo per «Archivia risultati»", "Tanti ticket = tante richieste al portale: meglio a blocchi."),
      sel("portalLang", [["auto", "Automatica (la stessa di Touch)"], ["it", "Italiano"], ["en", "Inglese"]], "Lingua del portale", "Automatica usa la lingua delle richieste della pagina di Touch. Ricarica la pagina dopo averla cambiata."),
      centroField(ctx),
      h("div", { class: "field" }, h("label", null, "Archivio"), h("label", { class: "check" }, cb, "Salva nell'archivio locale ogni ticket che apro"))));
}

/** Centro servizi dell'Area Riservata: di solito l'app lo trova da sola (dal gruppo di Touch); qui lo si può scrivere a mano. */
function centroField(ctx) {
  const found = ctx.arCentre ? ctx.arCentre() : "";
  const inp = h("input", { class: "input", type: "text", value: ctx.S.settings.arCentro || "", placeholder: found ? `trovato: ${found}` : "es. PAOW", maxlength: "12", style: { maxWidth: "160px", textTransform: "uppercase" } });
  inp.addEventListener("change", () => {
    ctx.S.settings.arCentro = inp.value.trim().toUpperCase();
    ctx.saveSettings();
  });
  return h("div", { class: "field" }, h("label", null, "Centro servizi dell'Area Riservata"), inp,
    h("div", { class: "hint" }, "Serve al Vecchio Cruscotto e allo Storico per cercare solo tra i ticket del tuo centro. Vuoto = lo trova l'app" + (found ? ` (ora: ${found}).` : ".")));
}

function archiveSection(ctx) {
  const info = h("span", null, `${(ctx.S.archiveCount || 0).toLocaleString("it-IT")} ticket nell'archivio locale di questo browser.`);
  return h("section", null,
    h("h3", null, "Archivio locale"),
    h("div", { style: { display: "flex", gap: "10px", alignItems: "center" } }, info,
      h("button", { class: "btn btn-small", onclick: async () => {
        if (!confirm("Cancellare tutti i ticket salvati nell'archivio locale?")) return;
        await clearArchive();
        await ctx.refreshArchiveCount();
        ctx.S.archived.clear();
        info.textContent = "Archivio svuotato.";
        toast("Archivio svuotato", "ok");
      } }, "Svuota")));
}

function logSection(ctx, setRedraw) {
  const pre = h("pre", { class: "log" }, ctx.LOG.slice(-180).join("\n") || "(vuoto)");
  if (setRedraw) setRedraw(() => { pre.textContent = ctx.LOG.slice(-180).join("\n") || "(vuoto)"; });
  return h("section", null,
    h("h3", null, "Registro"),
    h("p", { class: "hint" }, "Le ultime operazioni (utile in caso di problemi). Può contenere numeri di ticket: non condividerlo se non serve."),
    pre,
    h("div", null, h("button", { class: "btn btn-small", onclick: () => { navigator.clipboard.writeText(ctx.LOG.join("\n")); toast("Registro copiato", "ok", 1200); } }, icon("copy"), "Copia registro")));
}
