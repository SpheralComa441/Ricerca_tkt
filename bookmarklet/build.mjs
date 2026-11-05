// Genera il segnalibro a partire da src/ricerca-tkt.js.
//   node bookmarklet/build.mjs            (richiede esbuild: npx -y esbuild@0.24.0 oppure npm i esbuild)
// Produce:
//   dist/ricerca-tkt.min.js   codice minimizzato (da incollare nella console, F12)
//   dist/bookmarklet.txt      indirizzo "javascript:..." da usare come segnalibro
//   installa.html             pagina con il pulsante da trascinare nella barra dei preferiti
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  const req = createRequire(import.meta.url);
  for (const dir of (process.env.NODE_PATH || "").split(delimiter).filter(Boolean)) {
    try { esbuild = req(req.resolve("esbuild", { paths: [dir] })); break; } catch { /* prova la cartella successiva */ }
  }
}
if (!esbuild) {
  console.error("esbuild non trovato: esegui `npm i --no-save esbuild@0.24.0` nella cartella bookmarklet/ oppure imposta NODE_PATH.");
  process.exit(1);
}
const src = readFileSync(join(here, "src", "ricerca-tkt.js"), "utf8");
const version = (src.match(/const VERSION = "([^"]+)"/) || [])[1] || "?";
// Compatta gli spazi dei blocchi CSS e MARKUP (esbuild non tocca il contenuto delle stringhe).
const compact = src.replace(/(const (?:CSS|MARKUP) = `)([\s\S]*?)(`;)/g,
  (_, a, body, c) => a + body.replace(/\n\s*/g, " ").replace(/>\s+</g, "><").replace(/ {2,}/g, " ").trim() + c);
const { code } = await esbuild.transform(compact, {
  minify: true,
  target: "es2020",
  charset: "ascii",
  legalComments: "none",
});
const min = code.trim();
// Nei segnalibri vanno codificati solo i caratteri che il browser altererebbe.
const href = "javascript:" + min.replace(/[%#\r\n\t]/g, (c) => encodeURIComponent(c));
mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist", "ricerca-tkt.min.js"), min + "\n");
writeFileSync(join(here, "dist", "bookmarklet.txt"), href + "\n");

const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tpl = readFileSync(join(here, "installa.template.html"), "utf8");
const page = tpl
  .replaceAll("{{VERSION}}", version)
  .replaceAll("{{SIZE_KB}}", String(Math.round(href.length / 1024)))
  .replace("{{HREF_ATTR}}", () => escAttr(href))
  .replace("{{HREF_TEXT}}", () => escText(href))
  .replace("{{CONSOLE_TEXT}}", () => escText(min));
writeFileSync(join(here, "installa.html"), page);
console.log(`Ricerca TKT ${version}: segnalibro di ${Math.round(href.length / 1024)} KB, installa.html aggiornato.`);
