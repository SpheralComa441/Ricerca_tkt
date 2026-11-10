"""Portale HDA finto per provare l'interfaccia dell'estensione senza Touch.

Serve i file dell'estensione e simula, con dati INVENTATI, i servizi usati dall'app:
  POST /HDAPortal/WSCView/ListData/Incidents | TicketConversationItems
  POST /HDAPortal/WSCView/List?Entity=Incidents    (configurazione elenco, JS)
  POST /HDAPortal/WSC/Projection
  GET  /HDAPortal/WSCView/GetStaticList?entity=TicketStatuses

Uso:  python3 extension/dev/mock_server.py [porta]   →   http://localhost:8765/app/index.html
"""

import json
import random
import re
import sys
import urllib.parse
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

# colonne (stessi alias della mappa di riserva in lib/rows.js)
INC_MAP = {
    "c0": "Account.AccountCode", "c1": "Account.CompanyName", "c9": "AssignedUserID", "c10": "AssignedUser.FullName",
    "c14": "CLASSCLI", "c16": "Contact.FirstName", "c17": "Contact.LastName", "c19": "CTITMDESC", "c20": "Date",
    "c23": "ID", "c26": "LastChange", "c28": "NextExpirationDate", "c35": "OwnerUser.FullName",
    "c36": "OwnerUserGroup.Description", "c37": "OwnerUserGroupID", "c38": "OwnerUserID", "c40": "Problem",
    "c45": "Subject", "c50": "TicketPriority.Description", "c56": "TicketStatus.Description", "c59": "TicketStatusID",
    "c60": "TicketType.Description", "c61": "TicketTypeID",
}
CONV_MAP = {
    "c0": "Account.CompanyName", "c1": "AccountID", "c2": "Contact.FirstName", "c3": "Contact.LastName", "c4": "ContactID",
    "c5": "FirstUpdate", "c6": "FROMMAJINC", "c7": "ID", "c8": "MSGDIR", "c9": "OTHERDEPT", "c10": "REMOTETKT",
    "c11": "SiteVisible", "c12": "Text", "c13": "TicketConversationItemStat.AttachmentCount", "c14": "User.FullName", "c15": "UserID",
}

rnd = random.Random(42)
GROUPS = [("G100", "Paghe Infinity"), ("G200", "Contabilità Ad Hoc"), ("G300", "Presenze e HR"), ("G400", "Fatturazione elettronica")]
USERS = [("U1", "Laura Verdi"), ("U2", "Paolo Neri"), ("U3", "Giulia Galli"), ("U4", "Marco Fontana"), ("U5", "Sara Conti")]
ACCOUNTS = [("A1", "Alfa Meccanica Srl", "100234", "Brescia"), ("A2", "Beta Servizi Spa", "100877", "Milano"),
            ("A3", "Studio Gamma", "101552", "Lodi"), ("A4", "Delta Logistica Srl", "102001", "Bergamo"), ("A5", "Epsilon Coop", "103310", "Cremona")]
CONTACTS = [("C1", "Anna", "Bianchi"), ("C2", "Luca", "Ferrari"), ("C3", "Elena", "Russo"), ("C4", "Davide", "Colombo")]
CATALOG = [("K1", "Paghe Infinity"), ("K2", "Presenze Infinity"), ("K3", "Ad Hoc Revolution"), ("K4", "Fattura PA")]
STATUSES = [("S1", "New"), ("S2", "In progress"), ("S3", "Awaiting customer"), ("S6", "Solved"), ("S5", "Closed"), ("Z24C", "In carico al laboratorio")]
TYPES = [("T1", "Richiesta assistenza"), ("T10Z", "Informazione"), ("T3", "Anomalia")]
PRIOS = [("P2", "P2 - Alta"), ("P3", "P3 - Media"), ("P4", "P4 - Bassa")]
TOPICS = [
    ("Cedolino di gennaio con straordinari errati", "Buongiorno,<br>nel cedolino di gennaio del dipendente le ore di <b>straordinario</b> risultano raddoppiate. Potete verificare?<br><br>Grazie"),
    ("Errore invio F24 telematico", "<p>Salve, all'invio dell'F24 compare l'errore &quot;file non conforme&quot;.</p><p>Allego schermata.</p>"),
    ("Timbrature non importate", "Da ieri le timbrature del terminale non vengono importate in Presenze. Il servizio risulta avviato."),
    ("Fattura elettronica scartata dallo SDI", "<p>La fattura n. 123 è stata scartata con codice 00305.</p><ul><li>Cliente: ente pubblico</li><li>Codice univoco verificato</li></ul>"),
    ("Richiesta informazioni su conguaglio TFR", "Vorremmo sapere come gestire il conguaglio del TFR per un dipendente cessato a metà mese."),
    ("Stampa LUL lentissima", "La stampa del LUL impiega più di 20 minuti. Prima era immediata."),
    ("Licenza scaduta su postazione", "All'avvio compare il messaggio di licenza scaduta su una sola postazione."),
]

def ms(dt):
    return f"/Date({int(dt.timestamp() * 1000)})/"

NOW = datetime(2026, 11, 7, 17, 0)
TICKETS = []
for i in range(237):
    tid = f"{10500123 - i * 37}Z"
    subj, prob = TOPICS[i % len(TOPICS)]
    g, u, a, c, k = rnd.choice(GROUPS), rnd.choice(USERS), rnd.choice(ACCOUNTS), rnd.choice(CONTACTS), rnd.choice(CATALOG)
    st, ty, pr = rnd.choice(STATUSES), rnd.choice(TYPES), rnd.choice(PRIOS)
    opened = NOW - timedelta(days=i * 1.7, hours=rnd.randint(0, 8))
    last = opened + timedelta(days=rnd.randint(0, 6), hours=rnd.randint(1, 9))
    TICKETS.append({
        "ID": tid, "Subject": subj if i % 3 else f"{subj} (urgente)", "ProblemHTML": prob, "Problem": re.sub("<[^>]+>", " ", prob),
        "Date": opened, "LastChange": min(last, NOW), "TicketStatusID": st[0], "TicketStatus.Description": st[1],
        "TicketTypeID": ty[0], "TicketType.Description": ty[1], "TicketPriorityID": pr[0], "TicketPriority.Description": pr[1],
        "OwnerUserGroupID": g[0], "OwnerUserGroup.Description": g[1], "OwnerUserID": u[0], "OwnerUser.FullName": u[1],
        "AssignedUserID": u[0], "AssignedUser.FullName": u[1], "AccountID": a[0], "Account.CompanyName": a[1], "Account.AccountCode": a[2],
        "ContactID": c[0], "Contact.FirstName": c[1], "Contact.LastName": c[2], "CTITM": k[0], "CTITMDESC": k[1], "CLASSCLI": "Pro",
        "NextExpirationDate": last + timedelta(days=2),
        "SolutionHTML": "<p>Corretto il parametro nella tabella voci. Rielaborare il cedolino.</p>" if st[0] in ("S6", "S5") else "",
    })
# Ticket a 7 cifre: uno nativo di Touch con la Z e uno migrato dal Vecchio Cruscotto (ID senza Z)
for _tid, _subj, _days in (("9876543Z", "Detassazione premi di risultato (ticket Touch a 7 cifre)", 900), ("9042633", "Allineamento voci retributive (ticket migrato)", 1100)):
    _t = dict(TICKETS[0])
    _t.update({"ID": _tid, "Subject": _subj, "Date": NOW - timedelta(days=_days), "LastChange": NOW - timedelta(days=_days - 3),
               "TicketStatusID": "S5", "TicketStatus.Description": "Closed"})
    TICKETS.append(_t)
BY_ID = {t["ID"]: t for t in TICKETS}

def conversation(t):
    base = t["Date"]
    name = f'{t["Contact.FirstName"]} {t["Contact.LastName"]}'
    items = [
        {"ID": t["ID"] + "-0", "UserID": "#HDASRV#", "MSGDIR": "CREATION", "Text": t["Problem"], "FirstUpdate": base, "SiteVisible": True},
        {"ID": t["ID"] + "-1", "UserID": t["AssignedUserID"], "User.FullName": t["AssignedUser.FullName"], "Text": "Buongiorno, abbiamo preso in carico la segnalazione. Può indicarci la versione installata? Vedi anche tk 10500086 per un caso simile.", "FirstUpdate": base + timedelta(hours=2), "SiteVisible": True},
        {"ID": t["ID"] + "-2", "UserID": t["AssignedUserID"], "User.FullName": t["AssignedUser.FullName"], "Text": "Nota per il gruppo: probabile regressione dell'ultimo aggiornamento, verificato su ambiente di test.", "FirstUpdate": base + timedelta(hours=3), "SiteVisible": False},
        {"ID": t["ID"] + "-3", "UserID": "#HDAMAIL#", "ContactID": t["ContactID"], "Contact.FirstName": t["Contact.FirstName"], "Contact.LastName": t["Contact.LastName"], "Account.CompanyName": t["Account.CompanyName"],
         "Text": f"Versione 08.10.00, grazie.\n\nIl giorno {base:%d/%m/%Y} Assistenza ha scritto:\n> Buongiorno, abbiamo preso in carico la segnalazione.\n> Può indicarci la versione installata?", "FirstUpdate": base + timedelta(hours=5), "SiteVisible": True,
         "TicketConversationItemStat.AttachmentCount": 1},
        {"ID": t["ID"] + "-4", "UserID": t["AssignedUserID"], "User.FullName": t["AssignedUser.FullName"], "Text": ("Abbiamo verificato. " * 60) + "Le chiediamo di installare la patch 08.10.01 e riprovare.", "FirstUpdate": base + timedelta(days=1), "SiteVisible": True},
    ]
    return items

def val(v):
    return ms(v) if isinstance(v, datetime) else v

def matches(t, c):
    p, op, v = c.get("property"), c.get("op"), str(c.get("value", ""))
    if c.get("id") == "Domain":
        return True
    if c.get("extKey") == "MODIFIEDTICKET":
        return str(t.get("OwnerUserID") or "") in v.split("|")
    if p == "FullText":
        hay = (t["Subject"] + " " + t["Problem"]).lower()
        return all(w in hay for w in v.lower().split())
    if p == "CLASSCLI.TranslatedDescription":
        p = "CLASSCLI"
    if p not in t and p != "AssignedUserOrGroupID":
        raise ValueError(f"Proprietà sconosciuta: {p}")
    cur = t.get(p if p != "AssignedUserOrGroupID" else "AssignedUserID")
    if isinstance(cur, datetime):
        m = re.search(r"Date\((\d+)\)", v)
        dv = datetime.fromtimestamp(int(m.group(1)) / 1000) if m else datetime.fromisoformat(v[:19])
        return cur >= dv if op in ("ge", "gt") else cur <= dv
    if op == "in":
        if "|" in v or p in ("TicketStatusID", "TicketTypeID", "TicketPriorityID", "OwnerUserGroupID", "AssignedUserOrGroupID", "OwnerUserID", "AccountID", "ContactID", "CTITM"):
            return str(cur) in v.split("|")
        return v.lower() in str(cur).lower()
    if op == "eq":
        return str(cur) == v
    if op in ("like", "ct"):
        parts = [w for w in v.lower().split("%") if w]
        return all(w in str(cur).lower() for w in parts) if parts else True
    if op == "sw":
        if "%" in v:
            parts = [w for w in v.lower().split("%") if w]
            return all(w in str(cur).lower() for w in parts) if parts else True
        return str(cur).lower().startswith(v.lower())
    raise ValueError(f"Operatore sconosciuto: {op}")

def statics():
    return [{"ID": s, "Description": d} for s, d in STATUSES]

LIST_CFG = (
    'Ext.define("Mock.Incidents",{store:{proxy:{url:"/HDAPortal/WSCView/ListData/Incidents"},aliasExpressionMapping:'
    + json.dumps(INC_MAP)
    + ',"ViewID":"Default"},items:['
    '{id:"X_UC_filter_Default_Subject",itemId:"Subject","isFilter":true,"filterOperator":"in",xtype:"textfield",fieldLabel:"Subject",name:"Subject"},'
    '{id:"X_UC_filter_Default_FullText",itemId:"FullText","isFilter":true,"filterOperator":"eq","filterExtensionKey":"INCLUDECONVERSATIONITEM",xtype:"textfield",fieldLabel:"Full text",name:"FullText"}'
    "]});"
)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("mock: " + (fmt % args) + "\n")

    def send_json(self, obj, status=200):
        b = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def form(self):
        n = int(self.headers.get("Content-Length") or 0)
        return {k: v[0] for k, v in urllib.parse.parse_qs(self.rfile.read(n).decode(), keep_blank_values=True).items()}

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/HDAPortal/WSCView/GetStaticList"):
            return self.send_json({"success": True, "data": statics(), "total": len(STATUSES)})
        if u.path.startswith("/HDAPortal/"):
            return self.send_json({"success": False, "result": {"desc": "non simulato"}})
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        f = self.form()
        try:
            if u.path == "/HDAPortal/WSCView/ListData/Incidents":
                conds = json.loads(f.get("filter") or "{}").get("conditions", [])
                rows = [t for t in TICKETS if all(matches(t, c) for c in conds)]
                sort = (json.loads(f.get("sort") or "[]") or [{"property": "c20", "direction": "DESC"}])[0]
                key = INC_MAP.get(sort["property"], "Date")
                rows.sort(key=lambda t: t.get(key) or "", reverse=sort.get("direction") == "DESC")
                start, limit = int(f.get("start") or 0), int(f.get("limit") or 50)
                data = [{a: (val(t.get(e)) if e != "Problem" else t["Problem"][:500]) for a, e in INC_MAP.items()} for t in rows[start:start + limit]]
                return self.send_json({"success": True, "data": data, "total": len(rows)})
            if u.path == "/HDAPortal/WSCView/ListData/TicketConversationItems":
                conds = json.loads(f.get("filter") or "{}").get("conditions", [])
                tid = next((c["value"] for c in conds if c.get("property") == "TicketID"), None)
                items = conversation(BY_ID[tid]) if tid in BY_ID else []
                data = [{a: (val(it.get(e)) if e != "Text" else str(it.get("Text", ""))[:500]) for a, e in CONV_MAP.items()} for it in items]
                return self.send_json({"success": True, "data": data, "total": len(data)})
            if u.path == "/HDAPortal/WSCView/List":
                b = LIST_CFG.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/javascript; charset=utf-8")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                return self.wfile.write(b)
            if u.path == "/HDAPortal/WSC/Projection":
                ent = f.get("entity")
                conds = json.loads(f.get("filter") or "[]")
                names = json.loads(f.get("columnNames") or "[]")
                exprs = json.loads(f.get("columnExpressions") or "[]")
                limit = int(f.get("limit") or 100)
                if ent == "Incident":
                    src = [t for t in TICKETS if all(matches(t, c) for c in conds)]
                elif ent == "TicketConversationItem":
                    tid = next((c["value"] for c in conds if c.get("property") == "TicketID"), None)
                    src = conversation(BY_ID[tid]) if tid in BY_ID else []
                elif ent == "UserGroup":
                    src = [{"ID": i, "Description": d, "Active": True} for i, d in GROUPS]
                elif ent == "User":
                    src = [{"ID": i, "FullName": d, "Active": True} for i, d in USERS]
                elif ent == "CatalogItem":
                    src = [{"ID": i, "Description": d, "Code": i} for i, d in CATALOG]
                elif ent == "Account":
                    src = [{"ID": i, "CompanyName": n, "AccountCode": c, "City": city} for i, n, c, city in ACCOUNTS]
                    src = [r for r in src if all(matches(r, c) for c in conds)]
                else:
                    return self.send_json({"success": False, "result": {"desc": f"entità {ent} non simulata"}})
                data = [{n: val(r.get(e)) for n, e in zip(names, exprs)} for r in src[:limit]]
                return self.send_json({"success": True, "data": data, "total": len(src)})
            return self.send_json({"success": False, "result": {"desc": "non simulato: " + u.path}})
        except (ValueError, KeyError) as e:
            return self.send_json({"success": False, "result": {"desc": str(e)}})


if __name__ == "__main__":
    print(f"Portale finto su http://localhost:{PORT}/app/index.html")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
