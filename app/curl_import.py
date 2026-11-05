"""Importazione di una richiesta copiata dal browser con "Copy as cURL (bash)".

Serve a configurare con precisione la chiamata alla routine di ricerca
(endpoint, metodo, parametri) senza dover indovinare: si esegue una ricerca
sul sito Zucchetti, si copia la richiesta `spsl_fquery_mc` dagli strumenti
per sviluppatori e la si incolla nella pagina Diagnostica.
"""
from __future__ import annotations

import codecs
import re
import shlex
from urllib.parse import parse_qsl, urljoin, urlparse

SKIP_HEADERS = {
    "cookie", "content-length", "host", "connection", "accept-encoding", "origin",
    "referer", "user-agent", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
    "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "priority",
}


class CurlParseError(ValueError):
    pass


def _ansi_c(match: re.Match) -> str:
    body = match.group(1)
    try:
        decoded = codecs.decode(body.encode("latin-1", "backslashreplace"), "unicode_escape")
    except Exception:  # noqa: BLE001
        decoded = body
    return shlex.quote(decoded)


def parse_curl(command: str) -> dict:
    cmd = (command or "").strip()
    if not cmd.lower().startswith("curl"):
        raise CurlParseError("Il testo deve iniziare con 'curl' (usa 'Copy as cURL (bash)').")
    cmd = cmd.replace("\\\r\n", " ").replace("\\\n", " ")
    cmd = re.sub(r"\$'((?:[^'\\]|\\.)*)'", _ansi_c, cmd)
    try:
        tokens = shlex.split(cmd)
    except ValueError as exc:
        raise CurlParseError(f"Comando non interpretabile: {exc}") from exc
    url = None
    method = None
    headers: dict[str, str] = {}
    body_parts: list[str] = []
    i = 1
    while i < len(tokens):
        t = tokens[i]
        nxt = tokens[i + 1] if i + 1 < len(tokens) else None
        if t in ("-X", "--request"):
            method = (nxt or "").upper(); i += 2; continue
        if t in ("-H", "--header"):
            if nxt and ":" in nxt:
                k, v = nxt.split(":", 1)
                headers[k.strip()] = v.strip()
            i += 2; continue
        if t in ("-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode"):
            if nxt is not None:
                body_parts.append(nxt)
            i += 2; continue
        if t in ("-b", "--cookie", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-o", "--output"):
            i += 2; continue
        if t == "--url":
            url = nxt; i += 2; continue
        if t.startswith("-"):
            i += 1; continue
        if url is None:
            url = t
        i += 1
    if not url:
        raise CurlParseError("URL non trovato nel comando cURL.")
    parsed = urlparse(url)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    body = "&".join(body_parts)
    if body:
        params.update(dict(parse_qsl(body, keep_blank_values=True)))
    if method is None:
        method = "POST" if body else "GET"
    clean_headers = {k: v for k, v in headers.items() if k.lower() not in SKIP_HEADERS}
    return {
        "url": f"{parsed.scheme}://{parsed.netloc}{parsed.path}",
        "method": method,
        "params": params,
        "headers": clean_headers,
        "had_cookie": any(k.lower() == "cookie" for k in headers) or "-b" in tokens or "--cookie" in tokens,
    }


def to_template(parsed: dict, base_url: str, keyword: str) -> dict:
    """Trasforma la richiesta in un modello con i segnaposto {query}, {core}..."""
    url = parsed["url"]
    base = urljoin(base_url, "/")
    if url.startswith(base_url):
        endpoint = url[len(base_url):]
    elif urlparse(url).netloc == urlparse(base).netloc:
        endpoint = url
    else:
        raise CurlParseError("La richiesta non è diretta al sito configurato in base_url.")
    params = dict(parsed["params"])
    kw_param = None
    if keyword:
        for k, v in params.items():
            if v == keyword:
                kw_param = k
                break
        if kw_param is None:
            for k, v in params.items():
                if keyword.lower() in v.lower():
                    kw_param = k
                    break
    if kw_param is None and "pKeyword" in params:
        kw_param = "pKeyword"
    if kw_param is None:
        raise CurlParseError(
            "Non trovo il parametro con il testo cercato: indica esattamente la parola usata nella ricerca."
        )
    params[kw_param] = "{query}"
    for name, ph in (("pCore", "{core}"), ("pArea", "{area}"), ("pLangs", "{langs}")):
        if name in params:
            params[name] = ph
    m_cid = params.get("m_cID")
    return {
        "endpoint": endpoint,
        "method": parsed["method"],
        "params": params,
        "headers": parsed["headers"],
        "keyword_param": kw_param,
        "m_cID": m_cid,
    }
