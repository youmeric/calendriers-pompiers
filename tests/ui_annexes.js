// Dons hors tournée : saisie dans l'admin (Suivi & dons), totaux, annulation, dossier comptable.
const { chromium } = require("playwright");
const SP = process.env.TEST_DIR || require("os").tmpdir();
const B = process.env.TEST_URL || "http://127.0.0.1:8123";
function check(c, m) { console.log(`${c ? "OK  " : "FAIL"} ${m}`); if (!c) process.exitCode = 1; }
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const a = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  a.on("pageerror", (e) => errors.push(e.message));
  await a.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r) => r.abort());
  a.on("dialog", (d) => d.accept(d.type() === "prompt" ? "doublon" : undefined));
  await a.goto(`${B}/admin`); await a.fill("#password", "secret123"); await a.click("#login-form button");
  await a.waitForSelector("#editor-view:not([hidden])");
  const req = a.request;
  const autos = (await (await req.get(`${B}/api/admin/communes/courzieu`)).json()).auto_sectors;
  await req.put(`${B}/api/admin/communes/courzieu/sectors`, { data: { sectors: autos } });
  await req.put(`${B}/api/admin/settings`, { data: { suivi_adresses: true, dons_actifs: true } });
  await a.click('.admin-tab[data-tab="bilan"]'); await a.waitForTimeout(1200);
  check(await a.isVisible("#annexes-section") && (await a.textContent("#annexes-list")).includes("Aucun don hors tournée"), "Suivi & dons : rubrique « Dons hors tournée »");
  await a.fill("#ax-montant", "20"); await a.selectOption("#ax-origine", "boite"); await a.fill("#ax-note", "enveloppe sans nom");
  await a.click('#annexe-form button[type="submit"]'); await a.waitForTimeout(900);
  await a.fill("#ax-montant", "15,50"); await a.selectOption("#ax-mode", "cheque");
  check(await a.isVisible("#ax-cheque-box"), "chèque : champ du numéro");
  await a.fill("#ax-tx", "1234567"); await a.selectOption("#ax-origine", "decale"); await a.fill("#ax-note", "M. Martin, reçu le 20/11");
  await a.click('#annexe-form button[type="submit"]'); await a.waitForTimeout(900);
  const list = await a.textContent("#annexes-list");
  check(list.includes("Boîte aux lettres de la caserne") && list.includes("Reçu après la tournée") && list.includes("35,50 €"), "deux dons hors tournée : 35,50 €");
  check((await a.textContent("#bilan-cards")).includes("35,50 €"), "total des dons mis à jour");
  check((await a.textContent("#bilan-body")).includes("Dons hors tournée"), "tableau : ligne « Dons hors tournée »");
  await a.screenshot({ path: `${SP}/annexes-admin.png`, fullPage: true });
  await a.locator('#annexes-list [data-act="annuler"]').first().click(); await a.waitForTimeout(900);
  check((await a.textContent("#annexes-list")).includes("annulé : doublon") && (await a.textContent("#bilan-cards")).includes("20,00 €"), "annulation avec motif : sorti du total");
  const f = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  f.on("pageerror", (e) => errors.push(e.message));
  await f.goto(`${B}/admin`); await f.fill("#password", "secret123"); await f.click("#login-form button"); await f.waitForTimeout(800);
  await f.goto(`${B}/fiscal.html`); await f.waitForTimeout(1500);
  const fx = await f.textContent("body");
  check(fx.includes("dont dons hors tournée reçus directement") && fx.includes("Dons hors tournée (reçus par le trésorier)") && fx.includes("Boîte aux lettres de la caserne"),
    "dossier comptable : chaîne, ligne et registre");
  await f.screenshot({ path: `${SP}/annexes-fiscal.png`, fullPage: true });
  check(errors.length === 0, `aucune erreur JS ${errors.join(" | ")}`);
  await browser.close();
})();
