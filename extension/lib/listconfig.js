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
    if (c === '"' || c === "'") q = c;
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

export function parseFilters(src) {
  const byId = new Map();
  let from = 0;
  for (;;) {
    const idx = src.indexOf('"isFilter":true', from);
    if (idx < 0) break;
    from = idx + 15;
    const start = src.lastIndexOf("{id:", idx);
    if (start < 0 || idx - start > 2000) continue;
    const next = src.indexOf('"isFilter":true', from);
    let win = src.slice(start, Math.min(src.length, idx + 6000, next > 0 ? src.lastIndexOf("{id:", next) : Infinity));
    // il blocco dei listener contiene molte parentesi: basta la parte prima
    const lst = win.indexOf("listeners:");
    if (lst > 0) win = win.slice(0, lst);
    const f = {
      domId: str(win, "id"),
      itemId: str(win, "itemId"),
      op: str(win, "filterOperator"),
      xtype: str(win, "xtype"),
      label: str(win, "fieldLabel") || str(win, "emptyText"),
      name: str(win, "name"),
      isDefault: /"isDefaultFilter":true/.test(win),
      hidden: /(?:^|,)hidden:true/.test(win),
    };
    for (const m of win.matchAll(/"?(\w*[Ee]xt[Kk]ey\w*)"?:"([^"]*)"/g)) f.extKey = m[2];
    const prop = str(win, "filterProperty") || str(win, "property") || str(win, "dataField");
    if (prop) f.property = prop;
    if (!f.itemId) continue;
    const prev = byId.get(f.itemId);
    if (!prev || (prev.isDefault && !f.isDefault)) byId.set(f.itemId, f);
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
    storeUrl: (/url:"(\/HDAPortal\/WSCView\/ListData\/[^"]+)"/.exec(src) || [])[1] || null,
    viewId: (/"ViewID":"([^"]+)"/.exec(src) || [])[1] || null,
  };
}
