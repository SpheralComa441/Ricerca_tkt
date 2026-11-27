// Motore di controllo e download aggiornamenti per Ricerca TKT (GitHub main).
// Supporta:
//  1) Sessione GitHub già aperta nel browser (credentials: "include") — zero configurazione
//     anche su repository privato;
//  2) Token GitHub opzionale in sola lettura (Contents: Read-only) per colleghi o profili
//     non collegati a github.com.
// Il file ZIP scaricato viene poi applicato nella cartella locale dall'helper nativo
// (updater/host.ps1), seguito da chrome.runtime.reload().

export const REPO_OWNER = "SpheralComa441";
export const REPO_NAME = "Ricerca_tkt";
export const REPO_BRANCH = "main";
export const NATIVE_HOST_NAME = "it.ricercatkt.updater";

export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
export const RAW_MANIFEST_URL = `${REPO_URL}/raw/${REPO_BRANCH}/extension/manifest.json`;
export const ATOM_COMMITS_URL = `${REPO_URL}/commits/${REPO_BRANCH}.atom`;
export const ARCHIVE_ZIP_URL = `${REPO_URL}/archive/refs/heads/${REPO_BRANCH}.zip`;

const API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
export const API_MANIFEST_URL = `${API_BASE}/contents/extension/manifest.json?ref=${REPO_BRANCH}`;
export const API_COMMIT_URL = `${API_BASE}/commits/${REPO_BRANCH}`;
export const API_ZIP_URL = `${API_BASE}/zipball/${REPO_BRANCH}`;

/** Confronta due versioni numeriche tipo "5.1.0" vs "5.0.2". Restituisce -1, 0 o 1. */
export function compareVersions(a, b) {
  const pa = String(a || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** Estrae SHA, titolo e data dell'ultimo commit dal feed Atom di GitHub (`commits/main.atom`). */
export function parseAtomLatestCommit(xml) {
  if (!xml || typeof xml !== "string") return null;
  const entry = xml.match(/<entry\b[\s\S]*?<\/entry>/i);
  if (!entry) return null;
  const block = entry[0];
  const idM = block.match(/<id>[^<]*Commit\/([0-9a-f]{7,40})<\/id>/i) || block.match(/commit\/([0-9a-f]{7,40})/i);
  const titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const updM = block.match(/<updated>([^<]+)<\/updated>/i);
  const decode = (s) =>
    String(s || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .trim();
  const sha = idM ? idM[1] : "";
  if (!sha) return null;
  return {
    sha,
    shortSha: sha.slice(0, 7),
    message: titleM ? decode(titleM[1]) : "",
    date: updM ? updM[1].trim() : "",
  };
}

/** Converte un ArrayBuffer o Uint8Array in stringa Base64 senza sforare lo stack. */
export function arrayBufferToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Controlla che i byte inizino con la firma PK di un archivio ZIP valido (`PK\x03\x04` o `PK\x05\x06`). */
export function isValidZipBytes(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05);
}

function isGitHubLoginRedirect(res, text = "") {
  const url = String(res && res.url || "");
  if (/github\.com\/login/i.test(url)) return true;
  if (res && (res.status === 401 || res.status === 403 || res.status === 404)) return true;
  if (text && /^\s*<!doctype html|^\s*<html/i.test(text)) return true;
  return false;
}

/**
 * Controlla se su GitHub (`main`) esiste una versione più recente dell'estensione.
 * Restituisce:
 *  {
 *    status: "update_available" | "up_to_date" | "auth_required" | "error",
 *    currentVersion, remoteVersion, remoteSha, remoteShortSha, commitMessage, commitDate,
 *    checkedAt, authMode, error?
 *  }
 */
export async function checkRemoteUpdate({
  currentVersion = "0.0.0",
  installedSha = "",
  token = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  const checkedAt = Date.now();
  const cleanToken = String(token || "").trim();
  const authMode = cleanToken ? "token" : "session";

  try {
    let manifestJson = null;
    let commit = null;

    if (cleanToken) {
      const headers = {
        Authorization: `Bearer ${cleanToken}`,
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      const [mRes, cRes] = await Promise.all([
        fetchImpl(API_MANIFEST_URL, { headers, cache: "no-store" }),
        fetchImpl(API_COMMIT_URL, {
          headers: { ...headers, Accept: "application/vnd.github+json" },
          cache: "no-store",
        }).catch(() => null),
      ]);
      if (mRes.status === 401 || mRes.status === 403 || mRes.status === 404) {
        return {
          status: "auth_required",
          currentVersion,
          checkedAt,
          authMode,
          error: "Accesso negato al server aggiornamenti.",
        };
      }
      if (!mRes.ok) throw new Error(`Server aggiornamenti HTTP ${mRes.status}`);
      manifestJson = await mRes.json();
      if (cRes && cRes.ok) {
        const cj = await cRes.json().catch(() => null);
        if (cj && cj.sha) {
          commit = {
            sha: cj.sha,
            shortSha: cj.sha.slice(0, 7),
            message: String((cj.commit && cj.commit.message) || "").split("\n")[0].trim(),
            date: (cj.commit && cj.commit.committer && cj.commit.committer.date) || "",
          };
        }
      }
    } else {
      const mRes = await fetchImpl(RAW_MANIFEST_URL, { credentials: "include", cache: "no-store" });
      const mText = await mRes.text();
      if (!mRes.ok || isGitHubLoginRedirect(mRes, mText)) {
        return {
          status: "auth_required",
          currentVersion,
          checkedAt,
          authMode,
          error: "Archivio aggiornamenti privato o temporaneamente non raggiungibile.",
        };
      }
      manifestJson = JSON.parse(mText);
      const aRes = await fetchImpl(ATOM_COMMITS_URL, { credentials: "include", cache: "no-store" }).catch(() => null);
      if (aRes && aRes.ok) {
        const aText = await aRes.text();
        commit = parseAtomLatestCommit(aText);
      }
    }

    const remoteVersion = String((manifestJson && manifestJson.version) || "").trim();
    if (!remoteVersion) throw new Error("manifest.json remoto privo di campo version");

    const verCmp = compareVersions(remoteVersion, currentVersion);
    const shaChanged = !!(installedSha && commit && commit.sha && installedSha !== commit.sha);
    const hasUpdate = verCmp > 0 || (verCmp === 0 && shaChanged);

    return {
      status: hasUpdate ? "update_available" : "up_to_date",
      currentVersion,
      remoteVersion,
      remoteSha: commit ? commit.sha : "",
      remoteShortSha: commit ? commit.shortSha : "",
      commitMessage: commit ? commit.message : "",
      commitDate: commit ? commit.date : "",
      checkedAt,
      authMode,
    };
  } catch (e) {
    return {
      status: "error",
      currentVersion,
      checkedAt,
      authMode,
      error: e && e.message ? e.message : String(e),
    };
  }
}

/**
 * Scarica l'archivio ZIP dell'ultima versione disponibile,
 * verifica che sia uno ZIP autentico e restituisce i byte codificati in Base64.
 */
export async function downloadRemoteZipBase64({ token = "", fetchImpl = globalThis.fetch } = {}) {
  const cleanToken = String(token || "").trim();
  const res = cleanToken
    ? await fetchImpl(API_ZIP_URL, {
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      })
    : await fetchImpl(ARCHIVE_ZIP_URL, { credentials: "include", cache: "no-store" });

  if (!res.ok || /github\.com\/login/i.test(String(res.url || ""))) {
    const err = new Error(`Download aggiornamento non riuscito (HTTP ${res.status}).`);
    err.code = "AUTH_REQUIRED";
    throw err;
  }

  const buf = await res.arrayBuffer();
  if (!isValidZipBytes(buf)) {
    const err = new Error("La risposta ricevuta non è un archivio ZIP valido.");
    err.code = "AUTH_REQUIRED";
    throw err;
  }
  return {
    zipBase64: arrayBufferToBase64(buf),
    bytes: buf.byteLength,
  };
}
