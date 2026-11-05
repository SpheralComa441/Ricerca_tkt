"""Motore di ricerca dimostrativo.

Genera un archivio sintetico di ticket di assistenza paghe e implementa un
sottoinsieme della sintassi Lucene/Solr (AND/OR/NOT, parentesi, "frasi"~N,
campo:valore, intervalli [a TO b], prefisso*, fuzzy~). Restituisce risposte
nello stesso formato della routine Zucchetti, con lo stesso limite di
risultati, così l'interfaccia e la ricerca estesa si possono provare senza
credenziali.
"""
from __future__ import annotations

import html
import random
import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

TOKEN_RE = re.compile(r"[0-9A-Za-zÀ-ÖØ-öø-ÿ]+")


def tokenize(text: str) -> list[str]:
    return [t.lower() for t in TOKEN_RE.findall(text or "")]


# ---------------------------------------------------------------------------
# Generazione dati
# ---------------------------------------------------------------------------

TOPICS = [
    ("detassazione", "la detassazione del premio di risultato"),
    ("premio di risultato", "il premio di risultato"),
    ("conguaglio fiscale", "il conguaglio fiscale di fine anno"),
    ("TFR", "il calcolo del TFR"),
    ("tredicesima", "la tredicesima mensilità"),
    ("quattordicesima", "la quattordicesima mensilità"),
    ("cedolino", "la stampa del cedolino"),
    ("F24", "la delega F24"),
    ("UniEmens", "la denuncia UniEmens"),
    ("Certificazione Unica", "la Certificazione Unica"),
    ("modello 770", "il modello 770"),
    ("730", "il conguaglio 730"),
    ("addizionale regionale", "l'addizionale regionale"),
    ("addizionale comunale", "l'addizionale comunale"),
    ("ferie e permessi", "il residuo ferie e permessi"),
    ("malattia", "l'evento di malattia"),
    ("maternità", "l'indennità di maternità"),
    ("congedo parentale", "il congedo parentale"),
    ("straordinari", "il pagamento degli straordinari"),
    ("assunzione", "l'assunzione del dipendente"),
    ("cessazione", "la cessazione del rapporto"),
    ("trasferta", "le indennità di trasferta"),
    ("welfare aziendale", "il piano di welfare aziendale"),
    ("fringe benefit", "il fringe benefit"),
    ("buoni pasto", "i buoni pasto"),
    ("cassa integrazione", "la cassa integrazione"),
    ("apprendistato", "il contratto di apprendistato"),
    ("LUL", "il Libro Unico del Lavoro"),
    ("autoliquidazione INAIL", "l'autoliquidazione INAIL"),
    ("fondo pensione", "il versamento al fondo pensione"),
    ("rinnovo contrattuale", "il rinnovo contrattuale CCNL"),
    ("arretrati", "il calcolo degli arretrati"),
    ("esonero contributivo", "l'esonero contributivo"),
    ("trattamento integrativo", "il trattamento integrativo"),
    ("cuneo fiscale", "la riduzione del cuneo fiscale"),
]

SUBJECT_TPL = [
    "{T}", "{T}", "{T}", "{T} - errore calcolo", "Problema {t}", "{T} {mese}",
    "Domanda su {t}", "{T} non corretto", "{T}: chiarimenti", "Verifica {t}",
    "{T} dipendente {cognome}", "Anomalia {t} {anno}",
]
MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio",
        "agosto", "settembre", "ottobre", "novembre", "dicembre"]
COGNOMI = ["Rossi", "Bianchi", "Verdi", "Russo", "Ferrari", "Esposito", "Romano", "Colombo",
           "Ricci", "Marino", "Greco", "Bruno", "Gallo", "Conti", "De Luca", "Costa",
           "Giordano", "Mancini", "Rizzo", "Lombardi", "Moretti", "Barbieri", "Fontana"]
NOMI = ["Mario", "Laura", "Giulia", "Marco", "Paolo", "Sara", "Luca", "Anna", "Elena",
        "Davide", "Chiara", "Francesca", "Andrea", "Simone", "Martina", "Stefano"]
PRODUCTS = [("PAGHEW", 40), ("HRINF", 18), ("PRESWEB", 12), ("HRPORTAL", 8),
            ("GESTPERS", 8), ("NOTESP", 6), ("730WEB", 4), ("BUDGETHR", 4)]
STATI = [("Chiuso", 62), ("Risolto", 14), ("In lavorazione", 8), ("Aperto", 6),
         ("In attesa cliente", 6), ("Sospeso", 4)]
STATO_BASE = {"Chiuso": "Chiuso", "Risolto": "Chiuso"}
PRIORITA = [("Normale", 60), ("Bassa", 15), ("Alta", 20), ("Urgente", 5)]
TIPOLOGIE = [("Assistenza", 45), ("Anomalia", 20), ("Richiesta informazioni", 20),
             ("Consulenza", 10), ("Formazione", 5)]
GRUPPI = ["HR Paghe 1 livello", "HR Paghe 2 livello", "HR Fiscale", "HR Contributivo", "HR Presenze"]
OPERATORI = [f"{n} {c}" for n, c in zip(NOMI * 2, COGNOMI[::-1] + COGNOMI[:9])][:24]
CLASSIF = ["Normativa", "Procedura", "Anomalia software", "Configurazione", "Dati utente"]
CENTRI = [("[HR] Paghe Infinity", 70), ("[HR] Presenze", 20), ("[HR] Portale dipendente", 10)]
AZ_A = ["Alfa", "Beta", "Gamma", "Delta", "Omega", "Sigma", "Nord", "Sud", "Euro", "Tecno",
        "Edil", "Agri", "Meta", "Logi", "Info", "Medi"]
AZ_B = ["Servizi", "Consulting", "Impianti", "Sistemi", "Trasporti", "Costruzioni",
        "Commerciale", "Industria", "Studio", "Group"]
AZ_C = ["Srl", "Spa", "Snc", "Sas", "Srls"]

OPENINGS = [
    "Buongiorno, nel cedolino di {mese} {problema}.",
    "Buongiorno, chiediamo supporto perché {problema}.",
    "Salve, per il dipendente {cognome} {problema}.",
    "Buonasera, dopo l'aggiornamento {problema}.",
    "Gentile assistenza, {problema}.",
]
PROBLEMS = [
    "il calcolo per {art2} risulta errato",
    "non riusciamo a gestire {art2}",
    "il programma segnala un errore su {art2}",
    "l'importo relativo a {art2} non coincide con quanto atteso",
    "vorremmo sapere come configurare {art2}",
    "la stampa di controllo per {art2} è vuota",
]
DETAILS = [
    "Abbiamo seguito la procedura indicata ma il programma restituisce l'errore E{code}.",
    "Si allega la stampa di controllo con i valori riscontrati.",
    "Il problema riguarda circa {k} dipendenti dell'azienda.",
    "La situazione si presenta dal mese di {mese} {anno}.",
    "Abbiamo già rielaborato il cedolino senza risultati.",
    "Il dato proviene dalla CU {anno} del precedente datore di lavoro.",
    "La tabella contratti è stata aggiornata secondo il rinnovo CCNL.",
    "Chiediamo se è necessario intervenire anche sul modello F24.",
]
ANSWERS = [
    "Risposta: verificare la tabella {tab} e rielaborare il cedolino.",
    "Risposta: è stata rilasciata la patch {code}, installare l'aggiornamento.",
    "Risposta: il comportamento è corretto in base alla normativa vigente.",
    "Risposta: impostare il flag nella scheda dipendente e ricalcolare.",
    "Risposta: la segnalazione è stata girata al secondo livello.",
    "",
]
TABELLE = ["contratti", "voci retributive", "aliquote IRPEF", "enti previdenziali", "parametri ditta"]


def _wchoice(rng: random.Random, items):
    values = [i[0] for i in items]
    weights = [i[1] for i in items]
    return rng.choices(values, weights=weights, k=1)[0]


@dataclass(slots=True)
class Doc:
    idx: int
    number: int
    product: str
    date: date
    subject: str
    text: str
    stato: str
    stato_base: str
    priorita: str
    tipologia: str
    gruppo: str
    operatore: str
    azienda: str
    persona: str
    op_part: list
    gr_part: list
    classificazione: str
    argomento: str
    centro: str
    title_tokens: list
    subject_tokens: list
    text_tokens: list
    all_tokens: list

    @property
    def date_str(self) -> str:
        return self.date.strftime("%d-%m-%Y")


def generate(n: int = 40000, seed: int = 42, today: Optional[date] = None) -> list[Doc]:
    rng = random.Random(seed)
    today = today or date.today()
    start = date(2016, 1, 1)
    span = (today - start).days
    days = sorted(int(span * (rng.random() ** 0.6)) for _ in range(n))
    aziende = [f"{rng.choice(AZ_A)} {rng.choice(AZ_B)} {rng.choice(AZ_C)}" for _ in range(300)]
    persone = [f"{rng.choice(NOMI)} {rng.choice(COGNOMI)}" for _ in range(400)]
    number = 5_200_000
    step = max(1, int((9_100_000 - number) / max(n, 1)))
    docs: list[Doc] = []
    for i, d_off in enumerate(days):
        d = start + timedelta(days=d_off)
        number += rng.randint(max(1, step // 2), step + step // 2)
        topic, topic_long = rng.choice(TOPICS)
        mese = MESI[(d.month - 2) % 12]
        anno = d.year if d.month > 1 else d.year - 1
        fmt = {
            "T": topic[:1].upper() + topic[1:], "t": topic, "mese": mese, "anno": anno,
            "cognome": rng.choice(COGNOMI),
        }
        subject = rng.choice(SUBJECT_TPL).format(**fmt)
        if rng.random() < 0.35:
            subject = subject.lower()
        problema = rng.choice(PROBLEMS).format(art2=topic_long)
        parts = [rng.choice(OPENINGS).format(problema=problema, **fmt)]
        for _ in range(rng.randint(1, 3)):
            parts.append(rng.choice(DETAILS).format(
                code=rng.randint(100, 999), k=rng.randint(2, 80), mese=rng.choice(MESI),
                anno=rng.choice([anno, anno - 1, anno + 1]),
            ))
        if rng.random() < 0.25:
            other = rng.choice(TOPICS)[1]
            parts.append(f"Inoltre segnaliamo un dubbio su {other}.")
        parts.append(rng.choice(ANSWERS).format(tab=rng.choice(TABELLE), code=f"{d.year}.{rng.randint(1, 12)}"))
        text = " ".join(p for p in parts if p)
        stato = _wchoice(rng, STATI)
        if (today - d).days > 60 and stato not in ("Chiuso", "Risolto") and rng.random() < 0.85:
            stato = "Chiuso"
        product = _wchoice(rng, PRODUCTS)
        gruppo = rng.choice(GRUPPI)
        operatore = rng.choice(OPERATORI)
        op_part = sorted({operatore, *rng.sample(OPERATORI, rng.randint(0, 2))})
        gr_part = sorted({gruppo, *rng.sample(GRUPPI, rng.randint(0, 1))})
        title = f"[#{number}] [{product}] [{d.strftime('%d-%m-%Y')}]"
        t_tok = tokenize(title)
        s_tok = tokenize(subject)
        x_tok = tokenize(text)
        docs.append(Doc(
            idx=i, number=number, product=product, date=d, subject=subject, text=text,
            stato=stato, stato_base=STATO_BASE.get(stato, "Aperto"),
            priorita=_wchoice(rng, PRIORITA), tipologia=_wchoice(rng, TIPOLOGIE),
            gruppo=gruppo, operatore=operatore, azienda=rng.choice(aziende),
            persona=rng.choice(persone), op_part=op_part, gr_part=gr_part,
            classificazione=rng.choice(CLASSIF), argomento=topic,
            centro=_wchoice(rng, CENTRI),
            title_tokens=t_tok, subject_tokens=s_tok, text_tokens=x_tok,
            all_tokens=t_tok + s_tok + x_tok,
        ))
    return docs


# ---------------------------------------------------------------------------
# Parser della sintassi Lucene
# ---------------------------------------------------------------------------


class QuerySyntaxError(ValueError):
    pass


@dataclass
class Tok:
    kind: str  # LP RP AND OR NOT PLUS MINUS TERM PHRASE RANGE FIELD ALL
    value: object = None
    mod: Optional[str] = None  # ~N per frasi/termini


def lex(q: str) -> list[Tok]:
    toks: list[Tok] = []
    i, n = 0, len(q)
    while i < n:
        c = q[i]
        if c.isspace():
            i += 1
            continue
        if c == "(":
            toks.append(Tok("LP")); i += 1; continue
        if c == ")":
            toks.append(Tok("RP")); i += 1; continue
        if q.startswith("&&", i):
            toks.append(Tok("AND")); i += 2; continue
        if q.startswith("||", i):
            toks.append(Tok("OR")); i += 2; continue
        if c == "!" :
            toks.append(Tok("NOT")); i += 1; continue
        if c in "+-" and i + 1 < n and not q[i + 1].isspace():
            toks.append(Tok("PLUS" if c == "+" else "MINUS")); i += 1; continue
        if q.startswith("*:*", i):
            toks.append(Tok("ALL")); i += 3; continue
        if c == '"':
            j = i + 1
            buf = []
            while j < n and q[j] != '"':
                if q[j] == "\\" and j + 1 < n:
                    j += 1
                buf.append(q[j]); j += 1
            if j >= n:
                raise QuerySyntaxError("Virgolette non chiuse")
            j += 1
            mod = None
            m = re.match(r"~(\d+)?", q[j:])
            if m:
                mod = m.group(1) or "0"; j += m.end()
            toks.append(Tok("PHRASE", "".join(buf), mod)); i = j; continue
        if c in "[{":
            j = q.find("]" if c == "[" else "}", i)
            if j < 0:
                j = max(q.find("]", i), q.find("}", i))
            if j < 0:
                raise QuerySyntaxError("Intervallo non chiuso")
            inner = q[i + 1 : j]
            m = re.match(r"\s*(\S+)\s+TO\s+(\S+)\s*$", inner)
            if not m:
                raise QuerySyntaxError("Intervallo non valido")
            toks.append(Tok("RANGE", (m.group(1), m.group(2)))); i = j + 1; continue
        # termine (eventualmente campo:)
        j = i
        buf = []
        while j < n:
            ch = q[j]
            if ch == "\\" and j + 1 < n:
                buf.append(q[j + 1]); j += 2; continue
            if ch.isspace() or ch in '()"':
                break
            if ch == ":":
                break
            buf.append(ch); j += 1
        word = "".join(buf)
        if j < n and q[j] == ":" and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_\.]*", word):
            toks.append(Tok("FIELD", word)); i = j + 1; continue
        if j < n and q[j] == ":":
            buf.append(":"); j += 1  # due punti non di campo: parte del termine
            word = "".join(buf)
        if word in ("AND", "OR", "NOT"):
            toks.append(Tok(word)); i = j; continue
        mod = None
        m = re.search(r"~(\d+)?$", word)
        if m and not word.endswith("\\~"):
            mod = m.group(1) or "2"; word = word[: m.start()]
        if word:
            toks.append(Tok("TERM", word, mod))
        i = j
    return toks


class _P:
    def __init__(self, toks):
        self.t = toks
        self.i = 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def take(self, kind=None):
        tok = self.peek()
        if tok is None or (kind and tok.kind != kind):
            raise QuerySyntaxError("Sintassi della query non valida")
        self.i += 1
        return tok

    def parse(self):
        if not self.t:
            raise QuerySyntaxError("Query vuota")
        node = self.or_expr(None)
        if self.peek() is not None:
            raise QuerySyntaxError("Parentesi non bilanciate o operatore inatteso")
        return node

    def or_expr(self, fld):
        items = [self.and_expr(fld)]
        while self.peek() and self.peek().kind == "OR":
            self.take()
            items.append(self.and_expr(fld))
        return items[0] if len(items) == 1 else ("or", items)

    def and_expr(self, fld):
        items = [self.unary(fld)]
        while self.peek() and self.peek().kind not in ("OR", "RP"):
            if self.peek().kind == "AND":
                self.take()
            items.append(self.unary(fld))
        return items[0] if len(items) == 1 else ("and", items)

    def unary(self, fld):
        tok = self.peek()
        if tok is None:
            raise QuerySyntaxError("Query incompleta")
        if tok.kind in ("NOT", "MINUS"):
            self.take()
            return ("not", self.unary(fld))
        if tok.kind == "PLUS":
            self.take()
            return self.unary(fld)
        return self.primary(fld)

    def primary(self, fld):
        tok = self.take()
        if tok.kind == "LP":
            node = self.or_expr(fld)
            self.take("RP")
            return node
        if tok.kind == "ALL":
            return ("all",)
        if tok.kind == "FIELD":
            nxt = self.peek()
            if nxt is None:
                raise QuerySyntaxError("Valore mancante dopo il campo")
            if nxt.kind == "ALL":
                self.take(); return ("all",)
            if nxt.kind == "TERM" and nxt.value == "*":
                self.take(); return ("exists", tok.value)
            return self.primary(tok.value)
        if tok.kind == "TERM":
            return ("term", fld, tok.value, tok.mod)
        if tok.kind == "PHRASE":
            return ("phrase", fld, tok.value, tok.mod)
        if tok.kind == "RANGE":
            return ("range", fld, tok.value[0], tok.value[1])
        raise QuerySyntaxError("Sintassi della query non valida")


def parse_query(q: str):
    return _P(lex(q)).parse()


# ---------------------------------------------------------------------------
# Indice e valutazione
# ---------------------------------------------------------------------------

DEMO_FIELDS = {
    "TKNUMERO": "number", "TKDATA": "date", "TKPRODOTTO": "product",
    "TKOGGETTO": "subject", "TKTESTO": "text", "TKSTATO": "stato",
    "TKSTATOBASE": "stato_base", "TKPRIORITA": "priorita", "TKTIPOLOGIA": "tipologia",
    "TKGRUPPO": "gruppo", "TKOPERATORE": "operatore", "TKAZIENDA": "azienda",
    "TKPERSONA": "persona", "TKOPPART": "op_part", "TKGRPPART": "gr_part",
    "TKCLASSIF": "classificazione", "TKARGOMENTO": "argomento", "TKCENTRO": "centro",
}


def _lev1(a: str, b: str, maxd: int) -> bool:
    if abs(len(a) - len(b)) > maxd:
        return False
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        best = cur[0]
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
            best = min(best, cur[j])
        if best > maxd:
            return False
        prev = cur
    return prev[-1] <= maxd


class DemoIndex:
    def __init__(self, docs: list[Doc]):
        self.docs = docs
        self.universe = frozenset(range(len(docs)))
        self.post: dict[str, dict[str, set]] = {"_all": {}, "subject": {}, "text": {}}
        for d in docs:
            for fname, toks in (("_all", d.all_tokens), ("subject", d.subject_tokens), ("text", d.text_tokens)):
                idx = self.post[fname]
                for t in set(toks):
                    idx.setdefault(t, set()).add(d.idx)
        self.vocab = {k: sorted(v.keys()) for k, v in self.post.items()}
        self.by_number = {d.number: d.idx for d in docs}
        self._expand_cache: dict = {}

    # --- espansione termini -------------------------------------------------
    def expand(self, fname: str, term: str, mod: Optional[str]) -> list[str]:
        key = (fname, term, mod)
        if key in self._expand_cache:
            return self._expand_cache[key]
        term = term.lower()
        vocab = self.vocab[fname]
        if "*" in term or "?" in term:
            rx = re.compile("^" + re.escape(term).replace(r"\*", ".*").replace(r"\?", ".") + "$")
            out = [v for v in vocab if rx.match(v)]
        elif mod is not None:
            maxd = min(int(mod or 2), 2)
            out = [v for v in vocab if v[:1] == term[:1] and _lev1(term, v, maxd)]
        else:
            out = [term] if term in self.post[fname] else []
        self._expand_cache[key] = out
        if len(self._expand_cache) > 5000:
            self._expand_cache.clear()
        return out

    # --- valutazione --------------------------------------------------------
    def evaluate(self, node, hl: set) -> set:
        kind = node[0]
        if kind == "all":
            return set(self.universe)
        if kind == "and":
            pos = [c for c in node[1] if c[0] != "not"]
            neg = [c[1] for c in node[1] if c[0] == "not"]
            result = None
            for c in pos:
                s = self.evaluate(c, hl)
                result = s if result is None else result & s
            if result is None:
                result = set(self.universe)
            for c in neg:
                result -= self.evaluate(c, set())
            return result
        if kind == "or":
            out: set = set()
            for c in node[1]:
                if c[0] == "not":
                    out |= self.universe - self.evaluate(c[1], set())
                else:
                    out |= self.evaluate(c, hl)
            return out
        if kind == "not":
            return set(self.universe) - self.evaluate(node[1], set())
        if kind == "exists":
            return set(self.universe)
        if kind in ("term", "phrase"):
            return self._eval_text(node, hl)
        if kind == "range":
            return self._eval_range(node)
        raise QuerySyntaxError("Nodo sconosciuto")

    def _field_key(self, fld: Optional[str]) -> Optional[str]:
        if fld is None:
            return None
        key = DEMO_FIELDS.get(fld.upper())
        if key is None:
            raise QuerySyntaxError(f"Campo sconosciuto: {fld}")
        return key

    def _eval_text(self, node, hl: set) -> set:
        kind, fld, value, mod = node
        key = self._field_key(fld)
        value = str(value)
        if key in (None, "subject", "text"):
            fname = key or "_all"
            toks = tokenize(value) if not any(ch in value for ch in "*?") else [value.lower()]
            if not toks:
                return set()
            if kind == "term" and len(toks) == 1:
                words = self.expand(fname, toks[0], mod)
                hl.update(words)
                out: set = set()
                for w in words:
                    out |= self.post[fname].get(w, set())
                return out
            # frase (o termine composto da più parole)
            slop = int(mod) if (kind == "phrase" and mod) else 0
            sets = [self.post[fname].get(t, set()) for t in toks]
            cand = set.intersection(*sets) if sets else set()
            out = {i for i in cand if self._phrase_in(self._tokens(i, fname), toks, slop)}
            if out:
                hl.update(toks)
            return out
        if key == "number":
            if value.isdigit() and int(value) in self.by_number:
                return {self.by_number[int(value)]}
            return set()
        if key == "date":
            try:
                d = date.fromisoformat(value[:10])
            except ValueError:
                return set()
            return {doc.idx for doc in self.docs if doc.date == d}
        # campi "stringa"
        needle = value.lower()
        wild = "*" in needle or "?" in needle
        rx = re.compile("^" + re.escape(needle).replace(r"\*", ".*").replace(r"\?", ".") + "$") if wild else None
        n_toks = tokenize(needle)
        out = set()
        for doc in self.docs:
            vals = getattr(doc, key)
            for v in (vals if isinstance(vals, list) else [vals]):
                lv = v.lower()
                if (rx and rx.match(lv)) or lv == needle or (
                    not wild and n_toks and self._phrase_in(tokenize(lv), n_toks, 0)
                ):
                    out.add(doc.idx)
                    break
        return out

    def _tokens(self, i: int, fname: str) -> list[str]:
        d = self.docs[i]
        return d.all_tokens if fname == "_all" else d.subject_tokens if fname == "subject" else d.text_tokens

    @staticmethod
    def _phrase_in(tokens: list[str], phrase: list[str], slop: int) -> bool:
        first = phrase[0]
        for start, t in enumerate(tokens):
            if t != first:
                continue
            pos = start
            ok = True
            for p in phrase[1:]:
                found = False
                for k in range(pos + 1, min(len(tokens), pos + 2 + slop)):
                    if tokens[k] == p:
                        pos = k
                        found = True
                        break
                if not found:
                    ok = False
                    break
            if ok:
                return True
        return False

    def _eval_range(self, node) -> set:
        _, fld, lo, hi = node
        key = self._field_key(fld)
        if key == "number":
            a = -1 if lo == "*" else int(re.sub(r"\D", "", lo) or 0)
            b = 10**15 if hi == "*" else int(re.sub(r"\D", "", hi) or 0)
            return {d.idx for d in self.docs if a <= d.number <= b}
        if key == "date":
            a = date.min if lo == "*" else date.fromisoformat(lo[:10])
            b = date.max if hi == "*" else date.fromisoformat(hi[:10])
            return {d.idx for d in self.docs if a <= d.date <= b}
        raise QuerySyntaxError(f"Intervallo non supportato sul campo {fld}")

    # --- ricerca completa ---------------------------------------------------
    def search(self, q: str, cap: int) -> tuple[list[Doc], set]:
        node = parse_query(q)
        hl: set = set()
        ids = self.evaluate(node, hl)
        hl = {h for h in hl if h}
        docs = [self.docs[i] for i in ids]

        def score(d: Doc) -> tuple:
            s = 0
            for t in hl:
                s += 3 * d.subject_tokens.count(t) + d.text_tokens.count(t) + 2 * d.title_tokens.count(t)
            return (s, d.date)

        docs.sort(key=score, reverse=True)
        return docs[:cap], hl


# ---------------------------------------------------------------------------
# Rendering nel formato Zucchetti
# ---------------------------------------------------------------------------

HL_OPEN = '<span style="font-weight:bold;" solrfound="true">'
HL_CLOSE = "</span>"


def highlight(text: str, words: set) -> str:
    out = []
    last = 0
    for m in TOKEN_RE.finditer(text):
        out.append(html.escape(text[last : m.start()]))
        w = m.group(0)
        if w.lower() in words:
            out.append(HL_OPEN + html.escape(w) + HL_CLOSE)
        else:
            out.append(html.escape(w))
        last = m.end()
    out.append(html.escape(text[last:]))
    return "".join(out)


def snippet(text: str, words: set, width: int = 220) -> str:
    pos = None
    for m in TOKEN_RE.finditer(text):
        if m.group(0).lower() in words:
            pos = m.start()
            break
    if pos is None or len(text) <= width:
        part = text[:width]
        return part + (" ..." if len(text) > width else "")
    start = max(0, pos - width // 3)
    part = text[start : start + width]
    return ("... " if start else "") + part + (" ..." if start + width < len(text) else "")


FIELDS_OUT = ["id", "type", "img", "mimeType", "description", "altDescription",
              "url1", "url2", "url2lbl", "authCode", "urlPublic"]


def to_zucchetti_json(docs: list[Doc], words: set, cap: int, core: str = "TICKET") -> dict:
    data = []
    for d in docs:
        title = f"[#{d.number}] [{d.product}] [{d.date_str}] {d.subject}"
        data.append([
            str(d.number), "TICKET", "../images/gspv_ticket_search_grey_32.png", "",
            highlight(title, words), highlight(snippet(d.text, words), words),
            f"ticket/{d.number}", "", "", "", "",
        ])
    return {
        "fields": FIELDS_OUT,
        "data": data,
        "facet": [[core, str(len(docs)), core]],
        "maxResults": [str(cap)],
        "errors": [],
    }
