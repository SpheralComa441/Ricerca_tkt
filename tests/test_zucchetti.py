"""Connettore Zucchetti contro un finto server SitePainter (httpx.MockTransport)."""
import asyncio
import json
from urllib.parse import parse_qs

import httpx
import pytest

from app.connectors.base import LoginFailed, SessionExpired
from app.connectors.zucchetti import ZucchettiConnector, find_login_form
from app.curl_import import parse_curl, to_template

LOGIN_PAGE = """
<html><body><form name="FSender" action="../servlet/cp_login" method="post">
<input type="hidden" name="m_cAction" value="login">
<input type="hidden" name="m_cURL" value="../jsp/home.jsp">
<input type="text" name="m_cUserName" id="m_cUserName">
<input type="password" name="m_cPassword">
<input type="submit" value="Accedi">
</form></body></html>
"""
SEARCH_PORTLET = "this.splResults=new ZtVWeb.SPLinkerCtrl(...);\nthis.splResults.m_cID='abcdef0123456789abcdef0123456789';"


class FakeZucchetti:
    def __init__(self, sample: str):
        self.sample = sample
        self.calls = []
        self.logged = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        cookie = request.headers.get("cookie", "")
        authed = "JSESSIONID=ok" in cookie
        if path == "/areariservata/":
            return httpx.Response(302, headers={"Location": "/areariservata/jsp/login.jsp"})
        if path == "/areariservata/jsp/login.jsp":
            return httpx.Response(200, html=LOGIN_PAGE)
        if path == "/areariservata/servlet/cp_login":
            form = parse_qs(request.content.decode())
            if request.method == "GET":
                return httpx.Response(200, text="bye")
            if form.get("m_cUserName") == ["mario"] and form.get("m_cPassword") == ["segreta"] \
                    and form.get("m_cAction") == ["login"]:
                return httpx.Response(302, headers={"Location": "/areariservata/jsp/home.jsp",
                                                    "Set-Cookie": "JSESSIONID=ok; Path=/areariservata"})
            return httpx.Response(302, headers={"Location": "/areariservata/jsp/login.jsp"})
        if not authed:
            return httpx.Response(302, headers={"Location": "/areariservata/jsp/login.jsp"})
        if path == "/areariservata/jsp/home.jsp":
            return httpx.Response(200, html="<html>home ZtVWeb</html>")
        if path == "/areariservata/jsp/gspv_psearch.jsp":
            return httpx.Response(200, html="<html><script>ZtVWeb.addPortlet('x','spsl_wsolrresultsgrid')</script></html>")
        if path == "/areariservata/jsp/spsl_wsolrresultsgrid_portlet.jsp":
            return httpx.Response(200, text=SEARCH_PORTLET)
        if path == "/areariservata/servlet/spsl_fquery_mc":
            self.calls.append(parse_qs(request.content.decode(), keep_blank_values=True))
            return httpx.Response(200, text=self.sample)
        return httpx.Response(404)


@pytest.fixture
def fake(sample_response):
    return FakeZucchetti(sample_response)


@pytest.fixture
def connector(zcfg, fake, tmp_path):
    c = ZucchettiConnector(zcfg, tmp_path)
    c.transport = httpx.MockTransport(fake.handler)
    return c


def test_find_login_form():
    form = find_login_form(LOGIN_PAGE, "https://www.zucchetti.it/areariservata/jsp/login.jsp")
    assert form["action"] == "https://www.zucchetti.it/areariservata/servlet/cp_login"
    assert form["user_field"] == "m_cUserName"
    assert form["password_field"] == "m_cPassword"
    assert form["fields"]["m_cAction"] == "login"


def test_login_and_search(connector, fake):
    async def go():
        s = await connector.login("mario", "segreta")
        assert s.m_cID == "abcdef0123456789abcdef0123456789"
        raw = await s.search_raw('detassazione AND "04-2026"', "TICKET", "", "")
        await s.aclose()
        return raw

    raw = asyncio.run(go())
    assert json.loads(raw)["maxResults"] == ["210"]
    call = fake.calls[0]
    assert call["pKeyword"] == ['detassazione AND "04-2026"']
    assert call["pCore"] == ["TICKET"]
    assert call["m_cID"] == ["abcdef0123456789abcdef0123456789"]


def test_wrong_password(connector):
    with pytest.raises(LoginFailed):
        asyncio.run(connector.login("mario", "sbagliata"))


def test_cookie_login_and_expiry(connector, fake):
    async def go():
        s = await connector.login_with_cookie("JSESSIONID=ok; other=1", "mario")
        assert s.m_cID
        s.client.cookies.clear()
        with pytest.raises(SessionExpired):
            await s.search_raw("x", "TICKET", "", "")
        await s.aclose()

    asyncio.run(go())
    with pytest.raises(LoginFailed):
        asyncio.run(connector.login_with_cookie("JSESSIONID=scaduto", "mario"))


def test_curl_template(connector, fake, zcfg):
    curl = (
        "curl 'https://www.zucchetti.it/areariservata/servlet/spsl_fquery_mc' \\\n"
        "  -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \\\n"
        "  -H 'Cookie: JSESSIONID=segreto' \\\n"
        "  --data-raw $'m_cID=1ef51ea72b7e79d713e5b1b42030dfa2&pKeyword=detassazione&pArea=&pCore=TICKET&pLangs=&cs_SITE=&m_cParameterSequence=pKeyword'"
    )
    parsed = parse_curl(curl)
    assert parsed["had_cookie"]
    assert "Cookie" not in parsed["headers"]
    tpl = to_template(parsed, zcfg["base_url"], "detassazione")
    assert tpl["endpoint"] == "servlet/spsl_fquery_mc"
    assert tpl["params"]["pKeyword"] == "{query}"
    assert tpl["params"]["m_cParameterSequence"] == "pKeyword"

    connector.template_path.write_text(json.dumps(tpl))

    async def go():
        s = await connector.login("mario", "segreta")
        await s.search_raw("ciao", "TICKET", "", "")
        await s.aclose()

    asyncio.run(go())
    assert fake.calls[-1]["m_cParameterSequence"] == ["pKeyword"]
    assert fake.calls[-1]["pKeyword"] == ["ciao"]
