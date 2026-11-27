// FAQ di HDA TOUCH (Faqs): filtri verificati (senza Categoria/Tags), ricerca combinata Domanda+Risposta, HTMLPreview e client.
import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyFaqFilters,
  hasFaqFilter,
  faqRowId,
  isFaqId,
  faqLabel,
  faqStatusInfo,
  buildFaqConditions,
  makeFaqRowReader,
  buildFaqDoc,
  filterAndRankFaqs,
  makeFaq,
} from "../lib/faq.js";
import { formatTouchMsDate } from "../lib/kb.js";
import { parseHtmlPreviewResponse } from "../lib/hda.js";

function rawFaqRow(over = {}) {
  return {
    c0: "Per riconoscere i dipendenti di prima assunzione e il recupero delle voci di Tesoreria su UniEmens con causale CF05 viene verificato il campo dedicato nella sezione Istituti TFR.",
    c1: "FAQ25574HR",
    c2: 1,
    c3: 2,
    c4: "Pubblicato",
    c5: "/Date(1791291870953)/",
    c6: 5779,
    c7: "Italiano",
    c8: "/Date(1791291870877)/",
    c9: "Riforma TFR/Previdenza Complementare ‘DIPENDENTI DI PRIMA ASSUNZIONE’: come vengono riconosciuti?",
    c10: null,
    c11: null,
    ...over,
  };
}

test("faq touch: ID, etichette e stati", () => {
  assert.equal(faqRowId(5757), "FAQ5757");
  assert.equal(isFaqId("FAQ5757"), true);
  assert.equal(isFaqId("KB5757"), false);
  assert.equal(isFaqId("11943797Z"), false);
  assert.equal(faqLabel({ id: "FAQ5779", faqId: "5779", code: "FAQ25574HR" }), "FAQ25574HR");
  assert.equal(faqLabel({ id: "FAQ5779", faqId: "5779", code: "" }), "FAQ#5779");
  assert.equal(faqStatusInfo(2, "Pubblicato").tone, "pub");
  assert.equal(faqStatusInfo(1, "Pubblicato internamente").tone, "int");
  assert.equal(faqStatusInfo(0, "Non Pubblicato").tone, "draft");
});

test("faq touch: buildFaqConditions rispetta esattamente gli HAR di HD Touch (senza Categoria/Tags)", () => {
  assert.equal(hasFaqFilter(emptyFaqFilters()), false);
  assert.deepEqual(buildFaqConditions(emptyFaqFilters()), []);

  const f = {
    ...emptyFaqFilters(),
    question: "riforma TFR",
    answer: "UniEmens",
    code: "FAQ25373HR",
    statuses: ["1", "2"],
    folders: [{ id: "2189", label: "HR › Paghe" }],
    catalogItems: [{ id: "6458", label: "Paghe Infinity" }],
    importance: "1",
    dateFrom: "2026-11-01",
    dateTo: "2026-11-27",
    statusDateFrom: "2026-11-18",
  };
  assert.equal(hasFaqFilter(f), true);
  const conds = buildFaqConditions(f);
  const qConds = conds.filter((c) => c.id === "filterQuestion");
  assert.deepEqual(qConds, [
    { property: "Question", value: "riforma", op: "in", id: "filterQuestion" },
    { property: "Question", value: "TFR", op: "in", id: "filterQuestion" },
  ]);
  const byId = Object.fromEntries(conds.map((c) => [c.id, c]));
  assert.deepEqual(byId.filterAnswer, { property: "Answer", value: "UniEmens", op: "in", id: "filterAnswer" });
  assert.deepEqual(byId.filterCode, { property: "Code", value: "FAQ25373HR", op: "in", id: "filterCode" });
  assert.deepEqual(byId.filterStatus, { property: "FaqStatusID", value: "1|2", op: "eq", id: "filterStatus" });
  assert.deepEqual(byId.filterCatalogFolderID, { property: "Relations.CatalogFolder.ID", value: "2189", op: "eq", id: "filterCatalogFolderID" });
  assert.deepEqual(byId.filterCatalogItemID, { property: "Relations.CatalogItem.ID", value: "6458", op: "eq", id: "filterCatalogItemID" });
  assert.deepEqual(byId.FAQImportance, { property: "FAQINDEX", value: 1, op: "ge", id: "FAQImportance" });
  assert.deepEqual(byId.DateFromFilter, { property: "FirstUpdate", value: formatTouchMsDate("2026-11-01", false), op: "gt", id: "DateFromFilter" });
  assert.deepEqual(byId.DateToFilter, { property: "FirstUpdate", value: formatTouchMsDate("2026-11-27", true), op: "le", id: "DateToFilter" });
  assert.deepEqual(byId.DateCambioStatoFilter, { property: "FAQDTST", value: formatTouchMsDate("2026-11-18", false), op: "gt", id: "DateCambioStatoFilter" });
});

test("faq touch: ricerca combinata Domanda+Risposta supporta più parole, singolare/plurale e attinenza", () => {
  const reader = makeFaqRowReader();
  const r1 = reader.read(rawFaqRow());
  const r2 = reader.read(rawFaqRow({
    c6: 5857,
    c1: "FAQ25598HR",
    c9: "File SEPA HVB Unicredit Group adeguamento pain",
    c0: "Il tracciato SEPA è stato aggiornato per il gruppo di addebito.",
    c5: "/Date(1794909415947)/",
  }));
  const r3 = reader.read(rawFaqRow({
    c6: 5856,
    c1: "FAQ25580HR",
    c9: "Previdenza complementare in periodo di prova",
    c0: "Per il dipendente in prova i contributi previdenziali non vengono versati, il TFR sì.",
    c5: "/Date(1794908953070)/",
  }));

  // Singolare/plurale: "dipendente" trova "dipendenti", e una parola in Domanda ("riforma") + una in Risposta ("causale")
  const hit = filterAndRankFaqs([r1, r2, r3], "riforma dipendente causale");
  assert.deepEqual(hit.map((r) => r.faqId), ["5779"]);

  // Attinenza: parole vicine nella risposta salgono sopra
  const tfr = filterAndRankFaqs([r1, r2, r3], "TFR previdenza");
  assert.equal(tfr.length, 2);
  assert.ok(!tfr.some((r) => r.faqId === "5857"));
});

test("faq touch: HTMLPreview con HTML escapato (&lt;p&gt;) e client makeFaq con Projection per risposte lunghe", async () => {
  const rawPreview = 'Ext.ComponentManager.onAvailable("x",function(){Portal.x.add({bin:[{"ConfigurationHolder":true,"HTMLPreviewConfig":"{\\"data\\":{\\"Question\\":\\"Domanda completa?\\",\\"Data\\":{\\"Attachments\\":null},\\"AnswerHTML\\":\\"&lt;p&gt;Risposta &lt;b&gt;Fonchim&lt;/b&gt; completa.&lt;/p&gt;\\"},\\"htmlContents\\":[\\"AnswerHTML\\"]}"}]});});';
  const parsed = parseHtmlPreviewResponse(rawPreview);
  const reader = makeFaqRowReader();
  const row = reader.read(rawFaqRow({ c3: 1, c4: "Pubblicato internamente" }));
  const doc = buildFaqDoc({ row, preview: parsed, attachments: [] });
  assert.equal(doc.complete, true);
  assert.equal(doc.timeline.length, 2);
  assert.equal(doc.timeline[0].kind, "question");
  assert.equal(doc.timeline[1].kind, "doc");
  assert.match(doc.timeline[1].html, /<b>Fonchim<\/b>/);
  assert.match(doc.notes[0], /visibilità interna/);

  // Test ricerca su risposta troncata a 500 caratteri: Projection recupera il resto del testo!
  const longStart = "A".repeat(495);
  const fakeHda = {
    async listData() {
      return { rows: [rawFaqRow({ c6: 7001, c0: longStart, c9: "Adeguamento fondi pensione" })], total: 1 };
    },
    async projection(entity) {
      assert.equal(entity, "Faq");
      return [{ ID: "7001", Answer: longStart + " parola chiave Cometa nascosta oltre i 500 caratteri" }];
    },
    async htmlPreview() { return parsed; },
    async listEntityAttachments() { return []; },
  };
  const faq = makeFaq({ hda: fakeHda });
  const res = await faq.search({ filters: { ...emptyFaqFilters(), query: "fondi Cometa" } });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].faqId, "7001");
});
