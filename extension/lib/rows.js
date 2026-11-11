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
  statusText: { re: /^TicketStatus\.(Translated)?Description$/, fb: "c56" },
  typeId: { re: /^TicketTypeID$/, fb: "c61" },
  typeText: { re: /^TicketType\.(Translated)?Description$/, fb: "c60" },
  priorityText: { re: /^TicketPriority\.(Translated)?Description$/, fb: "c50" },
  date: { re: /^Date$/, fb: "c20", date: true },
  lastChange: { re: /^LastChange$/, fb: "c26", date: true },
  closureDate: { re: /^ClosureDate$/, date: true },
  nextExpiration: { re: /^NextExpirationDate$/, fb: "c28", date: true },
  account: { re: /^Account\.CompanyName$/, fb: "c1" },
  accountId: { re: /^AccountID$/ },
  customerCode: { re: /^Account\.(AccountCode|C41C)$/, fb: "c0" },
  contactFirst: { re: /^Contact\.FirstName$/, fb: "c16" },
  contactLast: { re: /^Contact\.LastName$/, fb: "c17" },
  ownerGroupId: { re: /^OwnerUserGroupID$/, fb: "c37" },
  ownerGroup: { re: /^OwnerUserGroup\.Description$/, fb: "c36" },
  ownerUserId: { re: /^OwnerUserID$/, fb: "c38" },
  ownerUser: { re: /^OwnerUser\.FullName$/, fb: "c35" },
  assignedId: { re: /^AssignedUserOrGroupID$|^AssignedUserID$/, fb: "c9" },
  assigned: { re: /^AssignedUser(OrGroup)?\.(FullName|Description|ObjectDescription)$/, fb: "c10" },
  catalog: { re: /^(CatalogItem|CTITM)\.(Translated)?Description$|^CTITMDESC$/, fb: "c19" },
  service: { re: /^Service\.(Translated)?Description$/, fb: "c41" },
  classCli: { re: /^CLASSCLI$/, fb: "c14" },
  sla: { re: /^(NextExpiration|ServiceLevel)\w*\.Description$/, fb: "c29" },
};

/** Costruisce il lettore delle righe per una configurazione (o null = mappa di riserva) */
export function makeRowReader(mapping) {
  const alias = {};
  const entries = mapping ? Object.entries(mapping) : [];
  for (const [field, def] of Object.entries(FIELDS)) {
    const hit = entries.find(([, expr]) => def.re.test(expr));
    if (hit) alias[field] = hit[0];
    else if (!entries.length && def.fb) alias[field] = def.fb;
  }
  function read(raw) {
    const o = {};
    for (const [field, a] of Object.entries(alias)) {
      let v = raw[a];
      if (FIELDS[field].date) v = parseMsDate(v);
      o[field] = v ?? null;
    }
    o.contact = [o.contactFirst, o.contactLast].filter(Boolean).join(" ");
    delete o.contactFirst;
    delete o.contactLast;
    o.raw = raw;
    return o;
  }
  return { read, alias, sortAlias: (field) => alias[field] || null };
}
