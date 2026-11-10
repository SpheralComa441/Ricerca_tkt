// Elenchi per i suggerimenti (gruppi, operatori, clienti, prodotti).
//
// Si caricano dal portale quando possibile (Projection) e in ogni caso si arricchiscono con
// quello che compare nei risultati delle ricerche ("raccolti"), così i suggerimenti funzionano
// anche se un elenco completo non è disponibile.

import { norm, tokens } from "./util.js";

const DAY = 86400000;

export function makeLookups(hda, { kvGet, kvSet, log = () => {} }) {
  const lists = { groups: new Map(), users: new Map(), accounts: new Map(), catalog: new Map() };
  const loaded = { groups: false, users: false, catalog: false };
  let fullAt = 0; // quando sono stati caricati gli elenchi completi (resta valido 7 giorni)
  const inflight = {}; // un solo caricamento alla volta per elenco (si scrive mentre carica)
  const failed = {}; // elenchi non disponibili: non si riprova a ogni tasto
  let dirty = false;
  let saveTimer = null;

  function add(kind, id, label, extra = {}) {
    if (!id || !label) return;
    const m = lists[kind];
    const prev = m.get(id);
    if (!prev || prev.label !== label) {
      m.set(id, { id, label, ...prev, ...extra, label });
      dirty = true;
    }
  }

  function scheduleSave() {
    if (!dirty || saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      dirty = false;
      const o = {};
      for (const [k, m] of Object.entries(lists)) o[k] = [...m.values()].slice(0, 30000);
      // il segno "elenco completo" va salvato insieme, altrimenti al riavvio si riscaricherebbe tutto
      const full = fullAt ? { at: fullAt, loaded: { ...loaded } } : undefined;
      await kvSet("lookups", { at: Date.now(), ...o, full });
    }, 1500);
  }

  async function restore() {
    const saved = await kvGet("lookups", null);
    if (!saved) return;
    for (const k of Object.keys(lists)) for (const x of saved[k] || []) lists[k].set(x.id, x);
    if (saved.full && Date.now() - (saved.full.at || 0) < 7 * DAY) {
      Object.assign(loaded, saved.full.loaded || {});
      fullAt = saved.full.at;
    }
  }

  /** Raccoglie gruppi, persone e clienti dalle righe dei risultati */
  function harvest(rows) {
    for (const r of rows) {
      add("groups", r.ownerGroupId, r.ownerGroup);
      add("users", r.ownerUserId, r.ownerUser);
      if (r.assignedId && r.assigned) add(/^G/.test(r.assignedId) ? "groups" : "users", r.assignedId, r.assigned);
      if (r.accountId) add("accounts", r.accountId, r.account, { code: r.customerCode || "" });
    }
    scheduleSave();
  }

  async function tryProjection(entities, columns, limit) {
    for (const e of entities) {
      try {
        return await hda.projection(e, [], columns, limit);
      } catch (err) {
        log(`elenco ${e}: ${err.message}`);
      }
    }
    return null;
  }

  function loadFull(kind) {
    if (loaded[kind]) return Promise.resolve(true);
    if (failed[kind] && Date.now() - failed[kind] < 10 * 60 * 1000) return Promise.resolve(false);
    if (!inflight[kind]) {
      inflight[kind] = loadFullNow(kind)
        .catch(() => false)
        .then((ok) => {
          if (!ok) failed[kind] = Date.now();
          delete inflight[kind];
          return ok;
        });
    }
    return inflight[kind];
  }

  async function loadFullNow(kind) {
    let ok = false;
    if (kind === "groups") {
      const rows = await tryProjection(["UserGroup", "UserGroups"], ["ID", "Description", "Active"], 5000);
      if (rows && rows.length) {
        rows.forEach((r) => add("groups", r.ID, r.Description, { inactive: r.Active === false }));
        ok = true;
      }
    } else if (kind === "users") {
      const rows = await tryProjection(["User", "Users"], ["ID", "FullName", "Active"], 30000);
      if (rows && rows.length) {
        rows.forEach((r) => add("users", r.ID, r.FullName, { inactive: r.Active === false }));
        ok = true;
      }
    } else if (kind === "catalog") {
      const rows = await tryProjection(["CatalogItem", "CatalogItems"], ["ID", "Description", "Code"], 10000);
      if (rows && rows.length) {
        rows.forEach((r) => add("catalog", r.ID, r.Description, { code: r.Code || "" }));
        ok = true;
      }
    }
    loaded[kind] = ok;
    if (ok) {
      fullAt = Date.now();
      dirty = true;
      scheduleSave();
    }
    return ok;
  }

  function match(items, q, limit = 30) {
    const ws = tokens(q);
    const out = [];
    for (const it of items) {
      const l = norm(it.label + " " + (it.code || "") + " " + it.id);
      if (ws.every((w) => l.includes(w))) out.push(it);
    }
    const q0 = norm(q);
    out.sort((a, b) => (norm(b.label).startsWith(q0) - norm(a.label).startsWith(q0)) || (a.inactive - b.inactive) || a.label.localeCompare(b.label));
    return out.slice(0, limit);
  }

  let accountOp = null;
  async function searchAccounts(q) {
    const t = String(q || "").trim();
    const local = match(lists.accounts.values(), t, 15);
    if (t.length < 2) return local;
    const cols = ["ID", "CompanyName", "AccountCode", "City"];
    const found = [];
    try {
      if (/^\d{3,}$/.test(t)) {
        found.push(...(await hda.projection("Account", [{ property: "AccountCode", op: "eq", value: t }], cols, 10)));
      } else {
        for (const op of accountOp ? [accountOp] : ["sw", "like"]) {
          try {
            const rows = await hda.projection("Account", [{ property: "CompanyName", op, value: t }], cols, 25);
            accountOp = op;
            found.push(...rows);
            break;
          } catch (e) {
            log(`clienti (${op}): ${e.message}`);
          }
        }
      }
    } catch (e) {
      log("ricerca clienti: " + e.message);
    }
    for (const r of found) add("accounts", r.ID, r.CompanyName, { code: r.AccountCode || "", city: r.City || "" });
    scheduleSave();
    const ids = new Set();
    return [...found.map((r) => lists.accounts.get(r.ID)), ...local].filter((x) => x && !ids.has(x.id) && ids.add(x.id)).slice(0, 30);
  }

  return {
    restore,
    harvest,
    loadFull,
    searchAccounts,
    label(kind, id) {
      return (lists[kind].get(id) || {}).label || null;
    },
    /** kind: groups | users | people (gruppi+operatori) | catalog */
    async search(kind, q) {
      if (kind === "accounts") return searchAccounts(q);
      if (kind === "people") {
        await Promise.all([loadFull("groups"), loadFull("users")]);
        const g = match(lists.groups.values(), q, 12).map((x) => ({ ...x, type: "Gruppo" }));
        const u = match(lists.users.values(), q, 18).map((x) => ({ ...x, type: "Operatore" }));
        return [...u, ...g];
      }
      await loadFull(kind);
      return match(lists[kind].values(), q);
    },
    sizes() {
      return Object.fromEntries(Object.entries(lists).map(([k, m]) => [k, m.size]));
    },
    loaded,
  };
}
