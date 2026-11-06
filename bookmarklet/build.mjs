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
import vm from "node:vm";

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

function toAscii(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    out += code > 0x7f ? "\\u" + code.toString(16).padStart(4, "0") : str[i];
  }
  return out;
}

function fallbackMinify(code) {
  let i = 0;
  const n = code.length;
  const REGEX_KW = new Set(["return", "throw", "case", "delete", "void", "typeof", "instanceof", "in", "of", "new", "yield", "await", "else", "do"]);
  const isIdentStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
  const isIdentPart = (c) => isIdentStart(c) || (c >= "0" && c <= "9");

  function lexTemplate() {
    let s = "`";
    i++;
    while (i < n) {
      const c = code[i];
      if (c === "\\") { s += toAscii(code.slice(i, i + 2)); i += 2; }
      else if (c === "`") { s += "`"; i++; break; }
      else if (c === "$" && code[i + 1] === "{") { i += 2; s += "${" + lexExpr(1) + "}"; }
      else { s += toAscii(c); i++; }
    }
    return s;
  }

  function lexExpr(braceDepth) {
    let sub = "";
    let subCanRegex = true;
    while (i < n && braceDepth > 0) {
      const c = code[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        while (i < n && (code[i] === " " || code[i] === "\t" || code[i] === "\r" || code[i] === "\n")) i++;
        const prev = sub[sub.length - 1] || "";
        const next = code[i] || "";
        if ((isIdentPart(prev) && isIdentPart(next)) || (prev === next && (prev === "+" || prev === "-"))) sub += " ";
        continue;
      }
      if (c === "/" && code[i + 1] === "/") {
        i += 2;
        while (i < n && code[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && code[i + 1] === "*") {
        i += 2;
        while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (c === "\"" || c === "'") {
        const q = c;
        let s = q;
        i++;
        while (i < n) {
          if (code[i] === "\\") { s += toAscii(code.slice(i, i + 2)); i += 2; }
          else if (code[i] === q) { s += q; i++; break; }
          else { s += toAscii(code[i]); i++; }
        }
        sub += s;
        subCanRegex = false;
        continue;
      }
      if (c === "`") {
        sub += lexTemplate();
        subCanRegex = false;
        continue;
      }
      if (c === "/" && subCanRegex) {
        let s = "/";
        i++;
        let inClass = false;
        while (i < n) {
          if (code[i] === "\\") { s += toAscii(code.slice(i, i + 2)); i += 2; }
          else if (code[i] === "[") { inClass = true; s += "["; i++; }
          else if (code[i] === "]") { inClass = false; s += "]"; i++; }
          else if (code[i] === "/" && !inClass) { s += "/"; i++; break; }
          else { s += toAscii(code[i]); i++; }
        }
        while (i < n && isIdentPart(code[i])) { s += code[i]; i++; }
        sub += s;
        subCanRegex = false;
        continue;
      }
      if (c === "{") { braceDepth++; i++; sub += "{"; subCanRegex = true; continue; }
      if (c === "}") {
        braceDepth--;
        i++;
        if (braceDepth === 0) break;
        sub += "}";
        subCanRegex = false;
        continue;
      }
      if (isIdentStart(c)) {
        let w = "";
        while (i < n && isIdentPart(code[i])) { w += code[i]; i++; }
        sub += w;
        subCanRegex = REGEX_KW.has(w);
        continue;
      }
      if (c >= "0" && c <= "9") {
        let num = "";
        while (i < n && (isIdentPart(code[i]) || code[i] === ".")) { num += code[i]; i++; }
        sub += num;
        subCanRegex = false;
        continue;
      }
      sub += c;
      i++;
      subCanRegex = "([{:;,=!?&|+-*~^%<>".includes(c);
    }
    return sub;
  }

  return lexExpr(1e9);
}

// «// @include file.js» inserisce un altro file di src/ (stesso ambito: dentro la funzione principale)
const src = readFileSync(join(here, "src", "ricerca-tkt.js"), "utf8")
  .replace(/^[ \t]*\/\/ @include ([\w.-]+\.js)[ \t]*$/gm, (_, name) => readFileSync(join(here, "src", name), "utf8"));
const version = (src.match(/const VERSION = "([^"]+)"/) || [])[1] || "?";
// Compatta gli spazi dei blocchi CSS e MARKUP (esbuild non tocca il contenuto delle stringhe).
const compact = src.replace(/(const (?:CSS|MARKUP) = `)([\s\S]*?)(`;)/g,
  (_, a, body, c) => a + body.replace(/\n\s*/g, " ").replace(/>\s+</g, "><").replace(/ {2,}/g, " ").trim() + c);
const code = esbuild
  ? (await esbuild.transform(compact, {
      minify: true,
      target: "es2020",
      charset: "ascii",
      legalComments: "none",
    })).code
  : fallbackMinify(compact);
const min = code.trim();
new vm.Script(min);
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
