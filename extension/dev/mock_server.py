"""Portale HDA finto per provare l'interfaccia dell'estensione senza Touch.

Simula con dati INVENTATI tutti i servizi usati da Ricerca TKT v5:
  - Incidents, TicketConversationItems, Projection, GetStaticList
  - KBArticles (ListData, List config, HTMLPreview, Attachments/AttachmentPreview)
  - Faqs (ListData, List config, HTMLPreview, Attachments/AttachmentPreview)
  - Services, CatalogItems, CatalogFolders (TreeData), GetStaticSimpleList, PreviewAttachment

Uso:  python3 extension/dev/mock_server.py [porta]   →   http://localhost:8765/app/index.html
"""

import base64
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
KB_MAP = {
    "c0": "Abstract", "c1": "Code", "c2": "FirstUpdate", "c3": "ID", "c4": "KB01.Name", "c5": "KB02.Name",
    "c6": "KB04.Description", "c7": "KB07", "c8": "KB11", "c9": "KBArticleStatus", "c10": "KBArticleStatus.ID",
    "c11": "KBArticleStatus.TranslatedDescription", "c12": "KBArticleType.Description", "c13": "Language.Description",
    "c14": "LastupdateUser.FullName", "c15": "Title",
}
FAQ_MAP = {
    "c0": "Answer", "c1": "Code", "c2": "FAQINDEX", "c3": "FaqStatus.StatusType", "c4": "FaqStatus.TranslatedDescription",
    "c5": "FirstUpdate", "c6": "ID", "c7": "Language.Description", "c8": "PublishDate", "c9": "Question",
    "c10": "VisibleFrom", "c11": "VisibleTo",
}

rnd = random.Random(42)
GROUPS = [("G100", "Paghe Infinity"), ("G200", "Contabilità Ad Hoc"), ("G300", "Presenze e HR"), ("G400", "Fatturazione elettronica")]
USERS = [("U1", "Laura Verdi"), ("U2", "Paolo Neri"), ("U3", "Giulia Galli"), ("U4", "Marco Fontana"), ("U5", "Sara Conti")]
ACCOUNTS = [("A1", "Alfa Meccanica Srl", "100234", "Brescia"), ("A2", "Beta Servizi Spa", "100877", "Milano"),
            ("A3", "Studio Gamma", "101552", "Lodi"), ("A4", "Delta Logistica Srl", "102001", "Bergamo"), ("A5", "Epsilon Coop", "103310", "Cremona")]
CONTACTS = [("C1", "Anna", "Bianchi"), ("C2", "Luca", "Ferrari"), ("C3", "Elena", "Russo"), ("C4", "Davide", "Colombo")]
CATALOG = [("6458", "Paghe Infinity", "Paghe"), ("6459", "Presenze Infinity", "Presenze Infinity"), ("6460", "Ad Hoc Revolution", "HR"), ("6461", "Fattura PA", "HR")]
SERVICES = [("S523C", "PAGHE INFINITY", "PW", "HR"), ("S524C", "PRESENZE INFINITY", "PR", "HR"), ("S575X", "HR CORE PLATFORM", "HC", "HR")]
FOLDERS = [
    {"id": "2180", "text": "HR", "children": [
        {"id": "2189", "leaf": True, "text": "Paghe"},
        {"id": "2191", "leaf": True, "text": "Presenze Infinity"},
        {"id": "2186", "leaf": True, "text": "HR Core Platform"},
    ]}
]
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
    return f"/Date({int(dt.timestamp() * 1000)})/" if dt else None

NOW = datetime(2026, 11, 27, 10, 30)
TICKETS = []
for i in range(60):
    tid = f"{10500123 - i * 37}Z"
    subj, prob = TOPICS[i % len(TOPICS)]
    g, u, a, c, k = rnd.choice(GROUPS), rnd.choice(USERS), rnd.choice(ACCOUNTS), rnd.choice(CONTACTS), rnd.choice(CATALOG)
    st, ty, pr = rnd.choice(STATUSES), rnd.choice(TYPES), rnd.choice(PRIOS)
    opened = NOW - timedelta(days=i * 1.4, hours=rnd.randint(0, 8))
    last = opened + timedelta(days=rnd.randint(0, 4), hours=rnd.randint(1, 9))
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
BY_ID = {t["ID"]: t for t in TICKETS}

KB_ARTICLES = [
    {
        "ID": 4356, "Code": "KB4356Z", "Title": "Decreto Omnibus: nuovo valore fringe benefit per auto aziendale",
        "Abstract": "Con la versione 26.12.00 è stata rilasciata la voce ZP0219, da utilizzare per identificare le variazioni relative al fringe benefit auto derivanti dal Decreto Omnibus.",
        "AbstractHTML": "<p>Con la versione <b>26.12.00</b> è stata rilasciata la voce <code>ZP0219</code> per identificare le variazioni del fringe benefit auto.</p><ul><li>Verificare i parametri in tabella voci</li><li>Rielaborare il cedolino del mese di dicembre</li></ul>",
        "FirstUpdate": NOW - timedelta(days=2), "KB07": NOW - timedelta(days=2),
        "KB01": "S523C", "KB01.Name": "PAGHE INFINITY", "KB02.Name": "26.12.00", "KB04": "6458", "KB04.Description": "Paghe Infinity",
        "FolderID": "2189", "KBArticleStatus.ID": 1, "KBArticleStatus": "Pubblicato", "KBArticleStatus.TranslatedDescription": "Pubblicato",
        "KBArticleTypeID": "1", "KBArticleType.Description": "Informazione", "LanguageID": "0", "Language.Description": "Default",
        "LastupdateUser.FullName": "MARIO ROSSI", "HASATTACH": False, "Attachments": [],
    },
    {
        "ID": 4335, "Code": "KB4335Z", "Title": "Migliorie e correzioni anomalie non presenti nel sommario dei cambiamenti 26.12.00",
        "Abstract": "Nel documento allegato vengono descritte le variazioni di dettaglio e il modello HR1NETNEG - Netti in busta negativi inviato con la versione 26.12.00.",
        "AbstractHTML": "<p>Nel documento allegato vengono descritte le variazioni che non sono state riportate nel sommario dei cambiamenti.</p><p>In allegato anche il modello <b>HR1NETNEG – Netti in busta negativi</b> per la versione 26.12.00.</p>",
        "FirstUpdate": NOW - timedelta(days=5), "KB07": None,
        "KB01": "S523C", "KB01.Name": "PAGHE INFINITY", "KB02.Name": "26.12.00", "KB04": "6458", "KB04.Description": "Paghe Infinity",
        "FolderID": "2189", "KBArticleStatus.ID": 3, "KBArticleStatus": "Pubblicato Internamente", "KBArticleStatus.TranslatedDescription": "Pubblicato Internamente",
        "KBArticleTypeID": "1", "KBArticleType.Description": "Informazione", "LanguageID": "0", "Language.Description": "Default",
        "LastupdateUser.FullName": "LAURA VERDI", "HASATTACH": True,
        "Attachments": [{"ID": "A880HR", "FileName": "HR1_26.12.00_000KB.txt   ", "ContentType": "text/plain   ", "Author": "Administrator", "KBSize": 12.4, "LastUpdate": NOW - timedelta(days=5), "Content": "Note di rilascio 26.12.00\n- Corretto arrotondamento netto in busta\n- Aggiornato modello HR1NETNEG"}],
    },
    {
        "ID": 4295, "Code": "KB4295Z", "Title": "Mancata selezione di aziende e dipendenti (browser Chrome)",
        "Abstract": "Dopo il caricamento della versione 26.11.00 potrebbero verificarsi anomalie nella selezione delle aziende o dei dipendenti su Chrome. Svuotare la cache del browser.",
        "AbstractHTML": "<p>Dopo il caricamento della versione 26.11.00 potrebbero verificarsi anomalie nella selezione delle aziende o dei dipendenti su Google Chrome.</p><p><b>Soluzione:</b> svuotare la cache del browser e ripetere la selezione.</p>",
        "FirstUpdate": NOW - timedelta(days=12), "KB07": NOW - timedelta(days=12),
        "KB01": "S523C", "KB01.Name": "PAGHE INFINITY", "KB02.Name": "26.11.00", "KB04": "6458", "KB04.Description": "Paghe Infinity",
        "FolderID": "2189", "KBArticleStatus.ID": 1, "KBArticleStatus": "Pubblicato", "KBArticleStatus.TranslatedDescription": "Pubblicato",
        "KBArticleTypeID": "2", "KBArticleType.Description": "Errore", "LanguageID": "1", "Language.Description": "Italiano",
        "LastupdateUser.FullName": "SARA CONTI", "HASATTACH": False, "Attachments": [],
    },
    {
        "ID": 1102, "Code": "KB12051HR", "Title": "{47077} INFO: Segnalazione di lentezza (controllo tempi calcolo cedolino)",
        "Abstract": "Questa comunicazione vuole dare un contributo al tema delle segnalazioni definite lentezza nel calcolo cedolino e nella parte interattiva.",
        "AbstractHTML": "<p>Questa comunicazione chiarisce come analizzare le segnalazioni di <b>lentezza</b>:</p><ol><li>Distinguere lentezza interattiva da lentezza di calcolo cedolino</li><li>Verificare tempi medi su ambiente test</li></ol>",
        "FirstUpdate": NOW - timedelta(days=40), "KB07": NOW - timedelta(days=39),
        "KB01": "S523C", "KB01.Name": "PAGHE INFINITY", "KB02.Name": "", "KB04": "6458", "KB04.Description": "Paghe Infinity",
        "FolderID": "2189", "KBArticleStatus.ID": 1, "KBArticleStatus": "Pubblicato", "KBArticleStatus.TranslatedDescription": "Pubblicato",
        "KBArticleTypeID": "1", "KBArticleType.Description": "Informazione", "LanguageID": "0", "Language.Description": "Default",
        "LastupdateUser.FullName": "Administrator", "HASATTACH": False, "Attachments": [],
    },
]

FAQS = [
    {
        "ID": 5857, "Code": "FAQ25598HR", "Question": "File SEPA “HVB Unicredit Group” adeguamento pain 001.001.009",
        "Answer": "Il tracciato file SEPA, riconosciuto nella tabella Gruppo di addebito, è stato adeguato al formato pain.001.001.009 con la versione 26.12.00 di Paghe Infinity.",
        "AnswerHTML": "&lt;p&gt;Il tracciato file SEPA, riconosciuto nella tabella &lt;b&gt;Gruppo di addebito&lt;/b&gt;, è stato adeguato al formato &lt;code&gt;pain.001.001.009&lt;/code&gt; con la versione 26.12.00 di Paghe Infinity.&lt;/p&gt;",
        "FirstUpdate": NOW - timedelta(days=3), "PublishDate": NOW - timedelta(days=3), "FAQDTST": NOW - timedelta(days=3),
        "VisibleFrom": None, "VisibleTo": None, "FaqStatusID": "1", "FaqStatus.StatusType": 2, "FaqStatus.TranslatedDescription": "Pubblicato",
        "Language.Description": "Default", "FAQINDEX": 1, "FolderID": "2189", "CatalogItemID": "6458", "Attachments": [],
    },
    {
        "ID": 5856, "Code": "FAQ25580HR", "Question": "Previdenza complementare L.199/2025 - Dipendenti in periodo di prova",
        "Answer": "Con la versione 26.12.00 di Paghe Infinity è stato inserito il nuovo campo Contribuzioni dovute nel periodo di prova nella gestione contrattuale Previdenza/Assistenza. Disattivando questo campo non verranno calcolati i contributi nel periodo di prova mentre resta attivo il TFR.",
        "AnswerHTML": "&lt;p&gt;Con la versione &lt;b&gt;26.12.00&lt;/b&gt; di Paghe Infinity è stato inserito il nuovo campo &lt;b&gt;Contribuzioni dovute nel periodo di prova&lt;/b&gt; nella gestione contrattuale Previdenza/Assistenza.&lt;/p&gt;&lt;p&gt;Disattivando questo campo non verranno calcolati i contributi dovuti per tutto il periodo di prova, mentre il TFR continua ad essere versato.&lt;/p&gt;",
        "FirstUpdate": NOW - timedelta(days=4), "PublishDate": NOW - timedelta(days=4), "FAQDTST": NOW - timedelta(days=4),
        "VisibleFrom": None, "VisibleTo": None, "FaqStatusID": "1", "FaqStatus.StatusType": 2, "FaqStatus.TranslatedDescription": "Pubblicato",
        "Language.Description": "Default", "FAQINDEX": 2, "FolderID": "2189", "CatalogItemID": "6458", "Attachments": [],
    },
    {
        "ID": 5779, "Code": "FAQ25574HR", "Question": "Riforma TFR/Previdenza Complementare ‘DIPENDENTI DI PRIMA ASSUNZIONE’: come vengono riconosciuti?",
        "Answer": "Per riconoscere i dipendenti di prima assunzione, al fine della valorizzazione del recupero voci di Tesoreria e relativa esposizione sul flusso UniEmens con causale CF05, viene verificata la non compilazione del campo Tipo lavoratore non di prima assunzione nella sezione Istituti - TFR.",
        "AnswerHTML": "&lt;p&gt;Per riconoscere i &lt;b&gt;dipendenti di prima assunzione&lt;/b&gt;, ai fini del recupero delle voci di Tesoreria e dell'esposizione su &lt;b&gt;UniEmens&lt;/b&gt; (causale &lt;code&gt;CF05&lt;/code&gt;), viene verificata la non compilazione del campo &lt;i&gt;Tipo lavoratore non di prima assunzione&lt;/i&gt;.&lt;/p&gt;",
        "FirstUpdate": NOW - timedelta(days=14), "PublishDate": NOW - timedelta(days=14), "FAQDTST": NOW - timedelta(days=14),
        "VisibleFrom": None, "VisibleTo": None, "FaqStatusID": "1", "FaqStatus.StatusType": 2, "FaqStatus.TranslatedDescription": "Pubblicato",
        "Language.Description": "Italiano", "FAQINDEX": 1, "FolderID": "2189", "CatalogItemID": "6458", "Attachments": [],
    },
    {
        "ID": 5757, "Code": "FAQ25540HR", "Question": "Tracciati TFR/previdenza complementare, a seguito della Riforma del TFR L.199/2025: quali adeguamenti dei Fondi sono previsti?",
        "Answer": "Gli adeguamenti previsti con la versione Paghe Infinity 26.10.00 riguardano i fondi Fonchim, Fonte e Cometa con le nuove specifiche per le adesioni automatiche e la distinta contributiva.",
        "AnswerHTML": "&lt;p&gt;Gli adeguamenti previsti con la versione &lt;b&gt;Paghe Infinity 26.10.00&lt;/b&gt; sono:&lt;/p&gt;&lt;p&gt;&lt;b&gt;Fonchim&lt;/b&gt;: nuovi campi nel tracciato per le adesioni automatiche.&lt;/p&gt;&lt;p&gt;&lt;b&gt;Fonte e Cometa&lt;/b&gt;: aggiornamento distinta contributiva mensile.&lt;/p&gt;",
        "FirstUpdate": NOW - timedelta(days=20), "PublishDate": NOW - timedelta(days=20), "FAQDTST": NOW - timedelta(days=20),
        "VisibleFrom": None, "VisibleTo": None, "FaqStatusID": "2", "FaqStatus.StatusType": 1, "FaqStatus.TranslatedDescription": "Pubblicato internamente",
        "Language.Description": "Italiano", "FAQINDEX": 0, "FolderID": "2189", "CatalogItemID": "6458", "Attachments": [],
    },
    {
        "ID": 5862, "Code": "FAQ25600HR", "Question": "Temporanea indisponibilità Cruscotto operativo Agenzia delle Entrate",
        "Answer": "Si riporta quanto indicato nel comunicato del 17 Novembre in merito alla temporanea manutenzione dei servizi telematici dell'Agenzia delle Entrate.",
        "AnswerHTML": "&lt;p&gt;Si riporta quanto indicato nel comunicato in merito alla manutenzione programmata del Cruscotto operativo Agenzia delle Entrate.&lt;/p&gt;",
        "FirstUpdate": NOW - timedelta(days=1), "PublishDate": None, "FAQDTST": NOW - timedelta(days=1),
        "VisibleFrom": NOW - timedelta(days=1), "VisibleTo": NOW + timedelta(days=2), "FaqStatusID": "3", "FaqStatus.StatusType": 0, "FaqStatus.TranslatedDescription": "Non Pubblicato",
        "Language.Description": "Default", "FAQINDEX": 0, "FolderID": "2189", "CatalogItemID": "6458", "Attachments": [],
    },
]

def conversation(t):
    base = t["Date"]
    return [
        {"ID": t["ID"] + "-0", "UserID": "#HDASRV#", "MSGDIR": "CREATION", "Text": t["Problem"], "FirstUpdate": base, "SiteVisible": True},
        {"ID": t["ID"] + "-1", "UserID": t["AssignedUserID"], "User.FullName": t["AssignedUser.FullName"], "Text": "Buongiorno, abbiamo preso in carico la segnalazione. Può indicarci la versione installata? Vedi anche tk 10500086 per un caso simile.", "FirstUpdate": base + timedelta(hours=2), "SiteVisible": True},
        {"ID": t["ID"] + "-2", "UserID": t["AssignedUserID"], "User.FullName": t["AssignedUser.FullName"], "Text": "Nota interna: probabile regressione dell'ultimo aggiornamento, verificato su ambiente di test.", "FirstUpdate": base + timedelta(hours=3), "SiteVisible": False},
        {"ID": t["ID"] + "-3", "UserID": "#HDAMAIL#", "ContactID": t["ContactID"], "Contact.FirstName": t["Contact.FirstName"], "Contact.LastName": t["Contact.LastName"], "Account.CompanyName": t["Account.CompanyName"],
         "Text": f"Versione 26.12.00, grazie.\n\nIl giorno {base:%d/%m/%Y} Assistenza ha scritto:\n> Buongiorno, abbiamo preso in carico la segnalazione.", "FirstUpdate": base + timedelta(hours=5), "SiteVisible": True},
    ]

def val(v):
    return ms(v) if isinstance(v, datetime) else v

def parse_dt_val(v):
    m = re.search(r"Date\((-?\d+)\)", str(v))
    return datetime.fromtimestamp(int(m.group(1)) / 1000) if m else datetime.fromisoformat(str(v)[:19])

def matches(t, c):
    p, op, v = c.get("property"), c.get("op"), str(c.get("value", ""))
    if c.get("id") == "Domain":
        return True
    if c.get("extKey") == "MODIFIEDTICKET":
        return str(t.get("OwnerUserID") or "") in v.split("|")
    if p == "FullText":
        hay = (t["Subject"] + " " + t["Problem"] + " " + " ".join(str(it.get("Text", "")) for it in conversation(t))).lower()
        return all((re.search(r"\b" + re.escape(w.rstrip("*")), hay) if w.endswith("*") else re.search(r"\b" + re.escape(w) + r"\b", hay)) is not None for w in v.lower().split())
    if p == "CLASSCLI.TranslatedDescription":
        p = "CLASSCLI"
    cur = t.get(p if p != "AssignedUserOrGroupID" else "AssignedUserID")
    if isinstance(cur, datetime):
        dv = parse_dt_val(v)
        return cur >= dv if op in ("ge", "gt") else cur <= dv
    if op == "in":
        if "|" in v or p in ("TicketStatusID", "TicketTypeID", "TicketPriorityID", "OwnerUserGroupID", "AssignedUserOrGroupID", "OwnerUserID", "AccountID", "ContactID", "CTITM"):
            return str(cur) in v.split("|")
        return v.lower() in str(cur or "").lower()
    if op == "eq":
        return str(cur) == v
    if op in ("like", "ct", "sw"):
        parts = [w for w in v.lower().split("%") if w]
        return all(w in str(cur or "").lower() for w in parts) if parts else True
    return True

def matches_kb(k, c):
    p, op, v = c.get("property"), c.get("op"), str(c.get("value", ""))
    if p == "FullText":
        hay = (k["Title"] + " " + k["Abstract"] + " " + k["Code"]).lower()
        return all((re.search(r"\b" + re.escape(w.rstrip("*")), hay) if w.endswith("*") else re.search(r"\b" + re.escape(w) + r"\b", hay)) is not None for w in v.lower().split())
    if p == "Title":
        return v.lower() in k["Title"].lower()
    if p == "Code":
        return k["Code"].lower() == v.lower()
    if p == "ID":
        return str(k["ID"]) == v
    if p == "KBArticleStatusID":
        return str(k["KBArticleStatus.ID"]) in v.split("|")
    if p == "KBArticleTypeID":
        return str(k["KBArticleTypeID"]) in v.split("|")
    if p == "KB01":
        return str(k["KB01"]) in v.split("|")
    if p == "KB02":
        return v.lower() in str(k.get("KB02.Name") or "").lower()
    if p == "KB04":
        return str(k["KB04"]) in v.split("|")
    if p == "Relations.CatalogFolder.ID":
        return str(k["FolderID"]) in v.split("|")
    if p == "LanguageID":
        return str(k["LanguageID"]) in v.split("|")
    if p == "Object.HASATTACH":
        return str(k["HASATTACH"]).lower() == v.lower()
    if p == "FirstUpdate":
        dv = parse_dt_val(v)
        return k["FirstUpdate"] >= dv if op in ("gt", "ge") else k["FirstUpdate"] <= dv
    return True

def matches_faq(q, c):
    p, op, v = c.get("property"), c.get("op"), str(c.get("value", ""))
    if p == "Question":
        return v.lower() in q["Question"].lower()
    if p == "Answer":
        return v.lower() in q["Answer"].lower()
    if p == "Code":
        return v.lower() in (q.get("Code") or "").lower()
    if p == "ID":
        return str(q["ID"]) == v
    if p == "FaqStatusID":
        return str(q["FaqStatusID"]) in v.split("|")
    if p == "Relations.CatalogFolder.ID":
        return str(q["FolderID"]) in v.split("|")
    if p == "Relations.CatalogItem.ID":
        return str(q["CatalogItemID"]) in v.split("|")
    if p == "FAQINDEX":
        return (q.get("FAQINDEX") or 0) >= float(v)
    if p in ("FirstUpdate", "FAQDTST"):
        dv = parse_dt_val(v)
        cur = q.get(p) or q["FirstUpdate"]
        return cur >= dv if op in ("gt", "ge") else cur <= dv
    return True

def list_cfg_js(name, mapping):
    return f'Ext.define("Mock.{name}",{{store:{{proxy:{{url:"/HDAPortal/WSCView/ListData/{name}"}},aliasExpressionMapping:{json.dumps(mapping)},"ViewID":"Default"}}}});'


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

    def send_js(self, src):
        b = src.encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/javascript; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def form(self):
        n = int(self.headers.get("Content-Length") or 0)
        return {k: v[0] for k, v in urllib.parse.parse_qs(self.rfile.read(n).decode(), keep_blank_values=True).items()}

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        ent = (qs.get("entity") or qs.get("Entity") or [""])[0]
        if u.path.startswith("/HDAPortal/WSCView/GetStatic"):
            if ent == "KBArticleStatuses":
                return self.send_json({"success": True, "data": [{"ID": "1", "ObjectDescription": "Pubblicato"}, {"ID": "3", "ObjectDescription": "Pubblicato Internamente"}, {"ID": "2", "ObjectDescription": "Non Pubblicato"}, {"ID": "4", "ObjectDescription": "Archived"}]})
            if ent == "KBArticleTypes":
                return self.send_json({"success": True, "data": [{"ID": "1", "ObjectDescription": "Informazione"}, {"ID": "2", "ObjectDescription": "Errore"}]})
            if ent == "FaqStatuses":
                return self.send_json({"success": True, "data": [{"ID": "1", "ObjectDescription": "Pubblicato"}, {"ID": "2", "ObjectDescription": "Pubblicato internamente"}, {"ID": "3", "ObjectDescription": "Non Pubblicato"}]})
            if ent == "Languages":
                return self.send_json({"success": True, "data": [{"ID": "0", "ObjectDescription": "Default"}, {"ID": "1", "ObjectDescription": "Italiano"}, {"ID": "2", "ObjectDescription": "English"}]})
            return self.send_json({"success": True, "data": [{"ID": s, "Description": d} for s, d in STATUSES]})
        if u.path.startswith("/HDAPortal/WSCView/HTMLPreview/"):
            rec_id = u.path.rsplit("/", 1)[-1]
            if ent == "KBArticle":
                k = next((x for x in KB_ARTICLES if str(x["ID"]) == rec_id), None)
                if k:
                    cfg = {"data": {"Title": k["Title"], "Code": k["Code"], "AbstractHTML": k["AbstractHTML"], "KB01": k["KB01"], "KB01name": k["KB01.Name"], "KB02": k["KB02.Name"], "KB04": k["KB04"], "KB04description": k["KB04.Description"], "KB07": val(k["KB07"]), "ObjectTypeID": k["KBArticleTypeID"], "Data": {"Attachments": [{"ID": a["ID"], "FileName": a["FileName"], "ParentObject": "KBArticle", "ParentObjectID": rec_id} for a in k["Attachments"]], "RelatedKBArticles": None}}, "htmlContents": ["AbstractHTML"]}
                    return self.send_js('Ext.ComponentManager.onAvailable("x",function(){var x={"ConfigurationHolder":true,"HTMLPreviewConfig":' + json.dumps(json.dumps(cfg)) + '};});')
            if ent == "Faq":
                q = next((x for x in FAQS if str(x["ID"]) == rec_id), None)
                if q:
                    cfg = {"data": {"Question": q["Question"], "AnswerHTML": q["AnswerHTML"], "Data": {"Attachments": None}}, "htmlContents": ["AnswerHTML"]}
                    return self.send_js('Ext.ComponentManager.onAvailable("x",function(){var x={"ConfigurationHolder":true,"HTMLPreviewConfig":' + json.dumps(json.dumps(cfg)) + '};});')
            return self.send_json({"success": False}, 404)
        if u.path.startswith("/HDAPortal/"):
            return self.send_json({"success": False, "result": {"desc": "non simulato"}})
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
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
            if u.path == "/HDAPortal/WSCView/ListData/KBArticles":
                conds = json.loads(f.get("filter") or "{}").get("conditions", [])
                rows = [k for k in KB_ARTICLES if all(matches_kb(k, c) for c in conds)]
                start, limit = int(f.get("start") or 0), int(f.get("limit") or 50)
                data = [{a: val(k.get(e)) for a, e in KB_MAP.items()} for k in rows[start:start + limit]]
                return self.send_json({"success": True, "data": data, "total": len(rows)})
            if u.path == "/HDAPortal/WSCView/ListData/Faqs":
                conds = json.loads(f.get("filter") or "{}").get("conditions", [])
                rows = [q for q in FAQS if all(matches_faq(q, c) for c in conds)]
                start, limit = int(f.get("start") or 0), int(f.get("limit") or 50)
                data = [{a: val(q.get(e)) for a, e in FAQ_MAP.items()} for q in rows[start:start + limit]]
                return self.send_json({"success": True, "data": data, "total": len(rows)})
            if u.path == "/HDAPortal/WSCView/ListData/Services":
                data = [{"c1": i, "c6": n, "c0": n, "c3": c, "c2": p, "c4": "Attivo", "c5": "Prodotto"} for i, n, c, p in SERVICES]
                return self.send_json({"success": True, "data": data, "total": len(data)})
            if u.path == "/HDAPortal/WSCView/ListData/CatalogItems":
                data = [{"c4": int(i), "c8": n, "c0": fl, "c2": "Pubblicato"} for i, n, fl in CATALOG]
                return self.send_json({"success": True, "data": data, "total": len(data)})
            if u.path == "/HDAPortal/WSCView/TreeData":
                return self.send_json(FOLDERS)
            if u.path == "/HDAPortal/WSCView/ListData/Attachments":
                conds = json.loads(f.get("filter") or "{}").get("conditions", [])
                po = next((c["value"] for c in conds if c.get("property") == "ParentObject"), "")
                pid = next((str(c["value"]) for c in conds if c.get("property") == "ParentObjectID"), "")
                atts = []
                if po == "KBArticle":
                    k = next((x for x in KB_ARTICLES if str(x["ID"]) == pid), None)
                    if k:
                        atts = [{"c0": a["ContentType"], "c1": a["FileName"], "c2": a["FileName"], "c3": a["Author"], "c4": a["ID"], "c5": a["KBSize"], "c6": val(a["LastUpdate"]), "c7": "KBArticle", "c8": pid} for a in k["Attachments"]]
                return self.send_json({"success": True, "data": atts, "total": len(atts)})
            if u.path == "/HDAPortal/WSCView/PreviewAttachment":
                aid = f.get("ID")
                for k in KB_ARTICLES:
                    for a in k["Attachments"]:
                        if a["ID"] == aid:
                            model = {"contentType": a["ContentType"].strip(), "fileName": a["FileName"].strip(), "content": base64.b64encode(a["Content"].encode()).decode()}
                            return self.send_js('{"ConfigurationHolder":true,"model":' + json.dumps(json.dumps(model)) + '}')
                return self.send_json({"success": False}, 404)
            if u.path == "/HDAPortal/WSCView/ListData/TicketConversationItems":
                conds = json.loads(f.get("filter") or "{}").get("conditions", [])
                tid = next((c["value"] for c in conds if c.get("property") == "TicketID"), None)
                items = conversation(BY_ID[tid]) if tid in BY_ID else []
                data = [{a: (val(it.get(e)) if e != "Text" else str(it.get("Text", ""))[:500]) for a, e in CONV_MAP.items()} for it in items]
                return self.send_json({"success": True, "data": data, "total": len(data)})
            if u.path == "/HDAPortal/WSCView/List":
                ent = (qs.get("Entity") or qs.get("entity") or ["Incidents"])[0]
                if ent == "KBArticles":
                    return self.send_js(list_cfg_js("KBArticles", KB_MAP))
                if ent == "Faqs":
                    return self.send_js(list_cfg_js("Faqs", FAQ_MAP))
                return self.send_js(list_cfg_js("Incidents", INC_MAP))
            if u.path == "/HDAPortal/WSC/Projection":
                ent = f.get("entity")
                conds = json.loads(f.get("filter") or "[]")
                names = json.loads(f.get("columnNames") or "[]")
                exprs = json.loads(f.get("columnExpressions") or "[]")
                limit = int(f.get("limit") or 100)
                if ent == "Incident":
                    src = [t for t in TICKETS if all(matches(t, c) for c in conds)]
                elif ent == "Faq":
                    ids = next((str(c["value"]).split("|") for c in conds if c.get("property") == "ID"), [])
                    src = [{"ID": str(q["ID"]), "Answer": q["Answer"]} for q in FAQS if not ids or str(q["ID"]) in ids]
                elif ent == "TicketConversationItem":
                    tids = next((str(c["value"]).split("|") for c in conds if c.get("property") == "TicketID"), [])
                    src = [dict(it, TicketID=tid) for tid in tids if tid in BY_ID for it in conversation(BY_ID[tid])]
                elif ent == "UserGroup":
                    src = [{"ID": i, "Description": d, "Active": True} for i, d in GROUPS]
                elif ent == "User":
                    src = [{"ID": i, "FullName": d, "Active": True} for i, d in USERS]
                elif ent == "CatalogItem":
                    src = [{"ID": i, "Description": d, "TranslatedDescription": d, "Code": i} for i, d, _ in CATALOG]
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
