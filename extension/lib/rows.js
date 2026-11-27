// Righe dell'elenco ticket (ListData/Incidents) → oggetti con nomi leggibili.
//
// ListData restituisce colonne anonime (c0, c1, …). Il significato si legge dalla configurazione
// dell'elenco (aliasExpressionMapping); se non è disponibile si usa la mappa ricavata dalle
// risposte reali dell'elenco "All tickets" (vista Default) del 07/11/2026.

import { parseMsDate } from "./util.js";

const FIELDS = {
  id: { re: /^ID$/, fb: "c23" },
  subject: { re: /^Subject$/, fb: "c45" },
  problem: { re: /^Problem$/, fb: "c40" },
  solution: { re: /^Solution$/, fb: "c44" },
  statusId: { re: /^TicketStatusID$/, fb: "c59" },
  statusText: { re: /^TicketStatus\.(Translated)?Description$|^TicketStatus$/, fb: "c57" },
  typeId: { re: /^TicketTypeID$/, fb: "c61" },
  typeText: { re: /^TicketType(\.(Translated)?Description)?$/, fb: "c60" },
  priorityText: { re: /^TicketPriority(\.(Translated)?Description)?$/, fb: "c50" },
  date: { re: /^Date$/, fb: "c20", date: true },
  lastChange: { re: /^LastChange$/, fb: "c26", date: true },
  closureDate: { re: /^ClosureDate$/, date: true },
  nextExpiration: { re: /^NextExpirationDate$/, fb: "c28", date: true },
  account: { re: /^Account\.CompanyName$/, fb: "c1" },
  accountId: { re: /^AccountID$/ },
  customerCode: { re: /^Account\.(AccountCode|C41C)$/, fb: "c0" },
  originalClient: { re: /^CLK\.CompanyName$/, fb: "c15" },
  originalContactFirst: { re: /^CCLK\.FirstName$/, fb: "c12" },
  originalContactLast: { re: /^CCLK\.LastName$/, fb: "c13" },
  contactFirst: { re: /^Contact\.FirstName$/, fb: "c16" },
  contactLast: { re: /^Contact\.LastName$/, fb: "c17" },
  ownerGroupId: { re: /^OwnerUserGroupID$/, fb: "c37" },
  ownerGroup: { re: /^OwnerUserGroup(\.(Translated)?Description)?$/, fb: "c36" },
  ownerUserId: { re: /^OwnerUserID$/, fb: "c38" },
  ownerUser: { re: /^OwnerUser\.FullName$/, fb: "c35" },
  assignedGroupId: { re: /^AssignedUserGroupID$/, fb: "c8" },
  assignedGroup: { re: /^AssignedUserGroup(\.(Translated)?Description)?$/, fb: "c7" },
  assignedId: { re: /^AssignedUserOrGroupID$|^AssignedUserID$/, fb: "c9" },
  assigned: { re: /^AssignedUserOrGroup$|^AssignedUser(OrGroup)?\.(FullName|Description|ObjectDescription)$/, fb: "c10" },
  assignedFirst: { re: /^AssignedUser\.FirstName$/, fb: "c4" },
  assignedLast: { re: /^AssignedUser\.LastName$/, fb: "c5" },
  catalog: { re: /^(CatalogItem|CTITM)\.(Translated)?Description$|^CTITMDESC$/, fb: "c19" },
  service: { re: /^Service(\.(Translated)?Description)?$/, fb: "c41" },
  supplier: { re: /^Supplier\.Name$/, fb: "c46" },
  classCli: { re: /^CLASSCLI$/, fb: "c14" },
  sla: { re: /^(NextExpiration|ServiceLevel)\w*\.Description$/, fb: "c29" },
};

function scalarValue(v) {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return v.TranslatedDescription || v.Description || v.FullName || v.Name || "";
  }
  return v ?? null;
}

/** Costruisce il lettore delle righe per una configurazione (o null = mappa di riserva) */
export function makeRowReader(mapping) {
  const alias = {};
  const entries = mapping ? Object.entries(mapping) : [];
  for (const [field, def] of Object.entries(FIELDS)) {
    // Preferisce la descrizione tradotta se presente (es. TicketStatus.TranslatedDescription prima di TicketStatus)
    const hits = entries.filter(([, expr]) => def.re.test(expr));
    const hit = hits.find(([, expr]) => /TranslatedDescription|Description|FullName/.test(expr)) || hits[0];
    if (hit) alias[field] = hit[0];
    else if (!entries.length && def.fb) alias[field] = def.fb;
  }
  function read(raw) {
    const o = {};
    for (const [field, a] of Object.entries(alias)) {
      let v = raw[a];
      if (FIELDS[field].date) v = parseMsDate(v);
      else v = scalarValue(v);
      o[field] = v ?? null;
    }
    o.contact = [o.contactFirst, o.contactLast].filter(Boolean).join(" ");
    delete o.contactFirst;
    delete o.contactLast;
    const origContact = [o.originalContactFirst, o.originalContactLast].filter(Boolean).join(" ");
    if (origContact) o.originalContact = origContact;
    delete o.originalContactFirst;
    delete o.originalContactLast;
    const assignedName = [o.assignedFirst, o.assignedLast].filter(Boolean).join(" ");
    if (!o.assigned && assignedName) o.assigned = assignedName;
    delete o.assignedFirst;
    delete o.assignedLast;
    o.raw = raw;
    return o;
  }
  return { read, alias, sortAlias: (field) => alias[field] || null };
}
