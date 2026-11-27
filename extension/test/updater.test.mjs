import test from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  parseAtomLatestCommit,
  arrayBufferToBase64,
  isValidZipBytes,
  checkRemoteUpdate,
  downloadRemoteZipBase64,
} from "../lib/updater.js";

test("updater: compareVersions gestisce versioni a 2 e 3 cifre", () => {
  assert.equal(compareVersions("5.1.0", "5.0.0"), 1);
  assert.equal(compareVersions("5.0.0", "5.1.0"), -1);
  assert.equal(compareVersions("5.1.10", "5.1.2"), 1);
  assert.equal(compareVersions("v5.1.0", "5.1.0"), 0);
  assert.equal(compareVersions("5.1", "5.1.0"), 0);
});

test("updater: parseAtomLatestCommit estrae SHA, titolo e data dal feed GitHub", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <id>tag:github.com,2008:Grit::Commit/546f58fa1b2c3d4e5f678901234567890abcdef0</id>
      <updated>2026-11-27T10:30:54Z</updated>
      <title>Ricerca TKT 5.1.0: tema chiaro &amp; auto-aggiornamento</title>
    </entry>
  </feed>`;
  const c = parseAtomLatestCommit(xml);
  assert.equal(c.sha, "546f58fa1b2c3d4e5f678901234567890abcdef0");
  assert.equal(c.shortSha, "546f58f");
  assert.equal(c.message, "Ricerca TKT 5.1.0: tema chiaro & auto-aggiornamento");
  assert.equal(c.date, "2026-11-27T10:30:54Z");
});

test("updater: checkRemoteUpdate rileva nuova versione tramite sessione browser", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("manifest.json")) {
      return {
        ok: true,
        status: 200,
        url,
        text: async () => JSON.stringify({ name: "Ricerca TKT", version: "5.2.0" }),
      };
    }
    return {
      ok: true,
      status: 200,
      url,
      text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/abcdef1234567890</id><title>Novità 5.2.0</title><updated>2026-11-28T09:00:00Z</updated></entry></feed>`,
    };
  };
  const r = await checkRemoteUpdate({ currentVersion: "5.1.0", fetchImpl });
  assert.equal(r.status, "update_available");
  assert.equal(r.remoteVersion, "5.2.0");
  assert.equal(r.remoteShortSha, "abcdef1");
  assert.equal(r.commitMessage, "Novità 5.2.0");
  assert.equal(calls[0].opts.credentials, "include");
});

test("updater: checkRemoteUpdate segnala auth_required su repo privato non autenticato", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: "https://github.com/login?return_to=...",
    text: async () => "<!DOCTYPE html><html>Sign in</html>",
  });
  const r = await checkRemoteUpdate({ currentVersion: "5.1.0", fetchImpl });
  assert.equal(r.status, "auth_required");
  assert.match(r.error, /privato/i);
});

test("updater: checkRemoteUpdate supporta token GitHub in sola lettura su API", async () => {
  let sawAuth = "";
  const fetchImpl = async (url, opts) => {
    sawAuth = opts.headers.Authorization;
    if (url.includes("/contents/")) {
      return { ok: true, status: 200, json: async () => ({ version: "5.1.0" }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ sha: "1234567890abcdef", commit: { message: "Fix rapido\nDettagli", committer: { date: "2026-11-27T11:00:00Z" } } }),
    };
  };
  const r1 = await checkRemoteUpdate({ currentVersion: "5.1.0", installedSha: "1234567890abcdef", token: "github_pat_test", fetchImpl });
  assert.equal(sawAuth, "Bearer github_pat_test");
  assert.equal(r1.status, "up_to_date");

  const r2 = await checkRemoteUpdate({ currentVersion: "5.1.0", installedSha: "0000000000000000", token: "github_pat_test", fetchImpl });
  assert.equal(r2.status, "update_available");
  assert.equal(r2.commitMessage, "Fix rapido");
});

test("updater: downloadRemoteZipBase64 valida intestazione ZIP PK e converte in base64", async () => {
  const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  assert.equal(isValidZipBytes(zipBytes), true);
  assert.equal(isValidZipBytes(new Uint8Array([0x3c, 0x68, 0x74, 0x6d])), false);

  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: "https://codeload.github.com/SpheralComa441/Ricerca_tkt/zip/refs/heads/main",
    arrayBuffer: async () => zipBytes.buffer,
  });
  const out = await downloadRemoteZipBase64({ fetchImpl });
  assert.equal(out.bytes, 8);
  assert.equal(out.zipBase64, arrayBufferToBase64(zipBytes));

  await assert.rejects(
    () =>
      downloadRemoteZipBase64({
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          url: "https://github.com/SpheralComa441/Ricerca_tkt/archive/refs/heads/main.zip",
          arrayBuffer: async () => new TextEncoder().encode("<html>login</html>").buffer,
        }),
      }),
    /non è un archivio ZIP valido/,
  );
});
