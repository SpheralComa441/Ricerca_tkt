// Knowledge Base di HDA TOUCH (KBArticles): filtri verificati, lettura righe, HTMLPreview, allegati e client.
import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyKbFilters,
  hasKbFilter,
  kbCodeFrom,
  kbRowId,
  isKbId,
  kbLabel,
  kbStatusInfo,
  formatTouchMsDate,
  buildKbConditions,
  makeKbRowReader,
  buildKbDoc,
  makeKb,
} from "../lib/kb.js";
import { parseHtmlPreviewResponse, normalizePreviewAttachment } from "../lib/hda.js";
import { ticketIdFrom } from "../lib/util.js";
import { relevance, TIERS } from "../lib/relevance.js";

function rawKbRow(over = {}) {
  return {
    c0: "Nel documento allegato vengono descritte le variazioni della versione 26.12.00 per il calcolo del cedolino.",
    c1: "KB4335Z",
    c2: "/Date(1792394323343)/",
    c3: 4335,
    c4: "PAGHE INFINITY",
    c5: "26.12.00",
    c6: "Paghe Infinity",
    c7: "/Date(1789682400000)/",
    c8: 2,
    c9: "Pubblicato Internamente",
    c10: 3,
    c11: "Pubblicato Internamente",
    c12: "Informazione",
    c13: "Default",
    c14: "LAURA VERDI",
    c15: "Migliorie e correzioni anomalie 26.12.00",
    ...over,
  };
}

test("kb touch: codici e ID articolo non si confondono con i ticket", () => {
  assert.deepEqual(kbCodeFrom("KB12051HR"), { code: "KB12051HR" });
  assert.deepEqual(kbCodeFrom("kb4335z"), { code: "KB4335Z" });
  assert.deepEqual(kbCodeFrom("KB#1102"), { kbId: "1102" });
  assert.deepEqual(kbCodeFrom("SKB#4243"), { kbId: "4243" });
  assert.equal(kbCodeFrom("2026"), null);
  assert.equal(kbCodeFrom("11943797Z"), null);
  assert.equal(kbCodeFrom("cedolino lentezza"), null);
  assert.equal(kbRowId(4243), "KB4243");
  assert.equal(isKbId("KB4243"), true);
  assert.equal(isKbId("FAQ5757"), false);
  assert.equal(isKbId("11943797Z"), false);
  assert.equal(kbLabel({ id: "KB4243", kbId: "4243", code: "KB25631HR" }), "KB25631HR");
  assert.equal(kbLabel({ id: "KB4243", kbId: "4243", code: "" }), "KB#4243");
  assert.equal(ticketIdFrom("KB12051HR"), null);
});

test("kb touch: buildKbConditions produce condizioni identiche agli HAR di HD Touch", () => {
  assert.equal(hasKbFilter(emptyKbFilters()), false);
  assert.deepEqual(buildKbConditions({ text: "", filters: emptyKbFilters() }), []);

  // Ricerca testo completo con asterisco automatico
  const ft = buildKbConditions({ text: "calcolo cedolino", autoWildcard: true, textMode: "fulltext" });
  assert.deepEqual(ft, [{ property: "FullText", value: "calcol* cedolin*", op: "eq", id: "FullText" }]);

  // Titolo: op "in", senza asterisco (in SQL LIKE l'asterisco sarebbe letterale)
  const tt = buildKbConditions({ text: "calcol* cedolino", textMode: "title" });
  assert.deepEqual(tt, [
    { property: "Title", value: "calcol", op: "in", id: "TitleFilter" },
    { property: "Title", value: "cedolino", op: "in", id: "TitleFilter" },
  ]);

  // Codice articolo scritto nella barra in alto (ignora i filtri)
  const byCode = buildKbConditions({ text: "KB25631HR", filters: { ...emptyKbFilters(), statuses: ["1"] } });
  assert.deepEqual(byCode, [{ property: "Code", value: "KB25631HR", op: "eq", id: "CodeFilter" }]);

  // Tutti i filtri verificati insieme
  const f = {
    ...emptyKbFilters(),
    title: "INFO",
    code: "KB12051HR",
    statuses: ["1", "3"],
    types: ["1", "2"],
    folders: [{ id: "2189", label: "HR › Paghe" }],
    topics: [{ id: "6458", label: "Paghe Infinity" }],
    languages: ["0", "1"],
    products: [{ id: "S575X", label: "PAGHE INFINITY" }],
    version: "26.12.00",
    dateFrom: "2026-11-01",
    dateTo: "2026-11-27",
    hasAttachments: "true",
  };
  assert.equal(hasKbFilter(f), true);
  const conds = buildKbConditions({ text: "", filters: f, textMode: "none" });
  const byId = Object.fromEntries(conds.map((c) => [c.id, c]));
  assert.deepEqual(byId.TitleFilter, { property: "Title", value: "INFO", op: "in", id: "TitleFilter" });
  assert.deepEqual(byId.CodeFilter, { property: "Code", value: "KB12051HR", op: "eq", id: "CodeFilter" });
  assert.deepEqual(byId.StatusFilter, { property: "KBArticleStatusID", value: "1|3", op: "eq", id: "StatusFilter" });
  assert.deepEqual(byId.TypeFilter, { property: "KBArticleTypeID", value: "1|2", op: "eq", id: "TypeFilter" });
  assert.deepEqual(byId.filterCatalogFolderIDKB, { property: "Relations.CatalogFolder.ID", value: "2189", op: "eq", id: "filterCatalogFolderIDKB" });
  assert.deepEqual(byId.filterCatalogItemIDKB, { property: "KB04", value: "6458", op: "eq", id: "filterCatalogItemIDKB" });
  assert.deepEqual(byId.LanguageIDFilter, { property: "LanguageID", value: "0|1", op: "eq", id: "LanguageIDFilter" });
  assert.deepEqual(byId.ServiceFilter, { property: "KB01", value: "S575X", op: "eq", id: "ServiceFilter" });
  assert.deepEqual(byId.ServiceVerFilter, { property: "KB02", value: "26.12.00", op: "in", id: "ServiceVerFilter" });
  assert.equal(byId.DateFromFilter.property, "FirstUpdate");
  assert.equal(byId.DateFromFilter.op, "gt");
  assert.equal(byId.DateFromFilter.value, formatTouchMsDate("2026-11-01", false));
  assert.equal(byId.DateToFilter.op, "le");
  assert.equal(byId.DateToFilter.value, formatTouchMsDate("2026-11-27", true));
  assert.deepEqual(byId.HasAttachments, { property: "Object.HASATTACH", value: "true", op: "eq", id: "HasAttachments" });
});

test("kb touch: lettura righe e parsing HTMLPreview + allegati (con trim degli spazi SQL)", () => {
  const reader = makeKbRowReader();
  const row = reader.read(rawKbRow());
  assert.equal(row.id, "KB4335");
  assert.equal(row.kbId, "4335");
  assert.equal(row.code, "KB4335Z");
  assert.equal(row.source, "kb");
  assert.equal(row.catalog, "PAGHE INFINITY");
  assert.equal(row.version, "26.12.00");
  assert.equal(row.topic, "Paghe Infinity");
  assert.equal(row.statusId, "3");
  assert.equal(row.statusTone, "int");
  assert.equal(row.typeText, "Informazione");
  assert.equal(row.assigned, "LAURA VERDI");
  assert.equal(kbStatusInfo("1").tone, "pub");
  assert.equal(kbStatusInfo("2").tone, "draft");
  assert.equal(relevance(row, "cedolino").tier, TIERS.ALL_NEAR_TEXT);

  // Parsing HTMLPreview reale (Ext.NET ConfigurationHolder)
  const previewRaw = 'Ext.ComponentManager.onAvailable("x",function(){Portal.x.add({bin:[{"ConfigurationHolder":true,"HTMLPreviewConfig":"{\\"data\\":{\\"AbstractHTML\\":\\"<p>Testo completo del <b>cedolino</b>.</p>\\",\\"Title\\":\\"Migliorie 26.12.00\\",\\"Code\\":\\"KB4335Z\\",\\"Data\\":{\\"Attachments\\":[{\\"ParentObjectID\\":\\"4335\\",\\"ID\\":\\"A880HR\\",\\"FileName\\":\\"HR1_26.12.00.pdf          \\",\\"ParentObject\\":\\"KBArticle\\"}],\\"RelatedKBArticles\\":[{\\"ID\\":\\"1102\\",\\"Code\\":\\"KB12051HR\\",\\"Title\\":\\"Lentezza\\"}]}},\\"htmlContents\\":[\\"AbstractHTML\\"]}"}]});});';
  const parsed = parseHtmlPreviewResponse(previewRaw);
  assert.equal(parsed.data.Code, "KB4335Z");

  const attFromList = normalizePreviewAttachment({
    c0: "application/pdf                           ",
    c1: "HR1_26.12.00.pdf                          ",
    c2: "HR1_26.12.00.pdf                          ",
    c3: "Administrator",
    c4: "A880HR",
    c5: 229.46,
    c6: "/Date(1790193146550)/",
    c7: "KBArticle",
    c8: "4335",
  }, "KBArticle", "4335");
  assert.equal(attFromList.fileName, "HR1_26.12.00.pdf");
  assert.equal(attFromList.contentType, "application/pdf");
  assert.equal(attFromList.sizeKb, 229.46);

  const doc = buildKbDoc({ row, preview: parsed, attachments: [attFromList] });
  assert.equal(doc.complete, true);
  assert.equal(doc.attachments.length, 1, "nessun doppione tra ListData/Attachments e HTMLPreview");
  assert.equal(doc.attachments[0].contentType, "application/pdf");
  assert.equal(doc.related.length, 1);
  assert.equal(doc.related[0].id, "KB1102");
  assert.match(doc.notes[0], /visibilità interna/);
  assert.equal(doc.timeline[0].kind, "doc");
  assert.match(doc.timeline[0].html, /<b>cedolino<\/b>/);
});

test("kb touch: client makeKb cerca in parallelo FullText + Title e carica il documento read-only", async () => {
  const calls = [];
  const fakeHda = {
    async listData(col, opts) {
      calls.push({ col, conds: opts.conditions });
      const hasTitle = opts.conditions.some((c) => c.property === "Title");
      return { rows: [rawKbRow(hasTitle ? { c3: 1102, c1: "KB12051HR", c15: "Lentezza cedolino" } : {})], total: 1 };
    },
    async htmlPreview(entity, id) {
      assert.equal(entity, "KBArticle");
      return { data: { AbstractHTML: "<p>Corpo completo KB " + id + "</p>", Title: "Titolo", Data: { Attachments: null, RelatedKBArticles: null } } };
    },
    async listEntityAttachments() {
      return [];
    },
  };

  const kb = makeKb({ hda: fakeHda });
  const res = await kb.search({ text: "cedolino", filters: emptyKbFilters() });
  assert.equal(calls.length, 2, "interroga FullText e Title in parallelo");
  assert.deepEqual(res.rows.map((r) => r.id).sort(), ["KB1102", "KB4335"]);

  const doc = await kb.loadDoc("KB4335", { row: res.rows.find((r) => r.id === "KB4335") });
  assert.equal(doc.complete, true);
  assert.match(doc.timeline[0].text, /Corpo completo KB 4335/);
});
