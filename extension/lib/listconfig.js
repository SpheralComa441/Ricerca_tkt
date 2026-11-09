// Lettura della configurazione di un elenco HDA (risposta JS di /HDAPortal/WSCView/List).
//
// La risposta contiene, tra l'altro:
//  - aliasExpressionMapping:{"c0":"Account.CompanyName",...}  → nome reale di ogni colonna cN
//  - le colonne della griglia (dataIndex:"c5", text:"User")
//  - i campi filtro: {id:"…_UC_filter_Default_filterText",itemId:"filterText","isFilter":true,
//    "filterOperator":"sw",xtype:"textfield",fieldLabel:"Detail",name:"Text",…}
// Da questi si ricavano in automatico proprietà e operatore di ogni filtro di Touch.

function findBalanced(src, start) {
  // src[start] === "{" → indice della "}" corrispondente (ignorando le stringhe)
  let depth = 0;
  let q = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseAliasMapping(src) {
  const k = src.indexOf("aliasExpressionMapping:");
  if (k < 0) return null;
  const s = src.indexOf("{", k);
  const e = findBalanced(src, s);
  if (s < 0 || e < 0) return null;
  try {
    return JSON.parse(src.slice(s, e + 1));
  } catch {
    return null;
  }
}

export function parseColumns(src) {
  const out = {};
  for (const m of src.matchAll(/dataIndex:"(c\d+)"([^{}]{0,400})/g)) {
    const t = /(?:^|,)text:"([^"]*)"/.exec(m[2]);
    if (t && !out[m[1]]) out[m[1]] = t[1];
  }
  return out;
}

function str(win, key) {
  const re = new RegExp(`(?:^|[,{])"?${key}"?:"((?:[^"\\\\]|\\\\.)*)"`);
  const m = re.exec(win);
  return m ? m[1].replace(/\\(["\\/])/g, "$1") : null;
}

function stripNested(objSrc) {
  // Mantiene solo il primo livello di { ... }, svuotando i blocchi { ... } annidati.
  let out = "";
  let depth = 0;
  let q = null;
  for (let i = 0; i < objSrc.length; i++) {
    const c = objSrc[i];
    if (q) {
      if (depth === 1) out += c;
      if (c === "\\") {
        i++;
        if (depth === 1 && i < objSrc.length) out += objSrc[i];
      } else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      if (depth === 1) out += c;
    } else if (c === "{") {
      depth++;
      if (depth <= 2) out += c;
    } else if (c === "}") {
      if (depth <= 2) out += c;
      depth--;
    } else if (depth === 1) {
      out += c;
    }
  }
  return out;
}

export function parseFilters(src) {
  const byId = new Map();
  let from = 0;
  for (;;) {
    const idx = src.indexOf('"isFilter":true', from);
    if (idx < 0) break;
    from = idx + 15;
    let start = src.lastIndexOf("{id:", idx);
    while (start >= 0 && idx - start < 40000) {
      const b = findBalanced(src, start);
      if (b > idx || b < 0) break;
      start = src.lastIndexOf("{id:", start - 1);
    }
    if (start < 0 || idx - start > 40000) continue;
    const bal = findBalanced(src, start);
    const win = bal > start && bal - start < 80000 ? src.slice(start, bal + 1) : src.slice(start, Math.min(src.length, idx + 8000));
    const top = stripNested(win);
    const f = {
      domId: str(top, "id"),
      itemId: str(top, "itemId"),
      op: str(top, "filterOperator"),
      xtype: str(top, "xtype"),
      label: str(top, "fieldLabel") || str(top, "emptyText"),
      name: str(top, "name") || str(top, "valueHiddenName"),
      isDefault: /"isDefaultFilter":true/.test(top),
      hidden: /(?:^|,)hidden:true/.test(top),
    };
    const extRe = /"?(?:filterExtensionKey|\w*[Ee]xt(?:ension)?[Kk]ey\w*)"?:"([^"]*)"/g;
    for (const m of top.matchAll(extRe)) {
      if (m[1]) f.extKey = m[1];
    }
    if (!f.extKey) {
      for (const m of win.matchAll(extRe)) {
        if (m[1]) f.extKey = m[1];
      }
    }
    const prop = str(top, "filterProperty") || str(top, "property") || str(top, "dataField");
    if (prop) f.property = prop;
    if (!f.itemId || f.itemId === "settingTriggerMenu") continue;
    const prev = byId.get(f.itemId);
    if (!prev) {
      byId.set(f.itemId, f);
    } else if (prev.isDefault && !f.isDefault) {
      byId.set(f.itemId, {
        ...prev,
        ...Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && v !== "")),
        isDefault: f.isDefault,
        hidden: f.hidden,
      });
    }
  }
  return [...byId.values()];
}

/** Filtri bloccati del modulo (es. stati e tipi predefiniti dell'elenco) */
export function parseModuleFilter(src) {
  const m = /\\?"filter\\?":\\?"(\[[^\]]*\])/.exec(src);
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/\\+"/g, '"'));
  } catch {
    return null;
  }
}

export function parseListConfig(src) {
  const mapping = parseAliasMapping(src) || {};
  return {
    mapping, // cN → espressione
    reverse: Object.fromEntries(Object.entries(mapping).map(([a, e]) => [e, a])),
    columns: parseColumns(src),
    filters: parseFilters(src),
    moduleFilter: parseModuleFilter(src),
    storeUrl: (/url:"(\/HDAPortal\/WSCView\/ListData\/[^"]+)"/.exec(src) || [])[1] || null,
    viewId: (/"ViewID":"([^"]+)"/.exec(src) || [])[1] || null,
  };
}
