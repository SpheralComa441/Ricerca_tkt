// Applica il tema salvato prima del primo render (nessun flash scuro/chiaro, conforme CSP MV3).
try {
  const t = localStorage.getItem("ricerca_tkt_theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}
