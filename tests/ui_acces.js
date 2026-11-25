// Accès personnel d'une personne : « Copier le lien » copie seulement le lien, « Copier le message » le message complet.
const { chromium } = require("playwright");
const B = process.env.TEST_URL || "http://127.0.0.1:8123";
function check(c, m) { console.log(`${c ? "OK  " : "FAIL"} ${m}`); if (!c) process.exitCode = 1; }
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const a = await ctx.newPage();
  const errors = [];
  a.on("pageerror", (e) => errors.push(e.message));
  await a.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r) => r.abort());
  await a.goto(`${B}/admin`); await a.fill("#password", "secret123"); await a.click("#login-form button");
  await a.waitForSelector("#editor-view:not([hidden])");
  const req = a.request;
  const autos = (await (await req.get(`${B}/api/admin/communes/courzieu`)).json()).auto_sectors;
  const secs = (await (await req.put(`${B}/api/admin/communes/courzieu/sectors`, { data: { sectors: autos } })).json()).sectors;
  const [jean] = (await (await req.post(`${B}/api/admin/personnes`, { data: { personnes: [{ nom: "Jean Dupont", telephone: "0612345678" }] } })).json()).personnes;
  await req.put(`${B}/api/admin/secteurs/${secs[0].id}/equipe`, { data: { membres: [{ personne_id: jean.id, role: "responsable" }] } });
  await a.click('.admin-tab[data-tab="equipes"]'); await a.waitForTimeout(1200);
  await a.locator('[data-action="access"]').first().click(); await a.waitForTimeout(300);
  check(await a.isVisible("#access-dialog"), "fenêtre d'accès ouverte");
  await a.click("#access-copy"); await a.waitForTimeout(200);
  const lien = await a.evaluate(() => navigator.clipboard.readText());
  check(lien === `${B}/equipe#acces=${jean.code}`, `« Copier le lien » : seulement le lien (${lien})`);
  await a.click("#access-copy-msg"); await a.waitForTimeout(200);
  const msg = await a.evaluate(() => navigator.clipboard.readText());
  check(msg.startsWith("Bonjour Jean") && msg.includes(lien) && msg.includes("code"), "« Copier le message » : le message complet avec le lien");
  check(errors.length === 0, `aucune erreur JS ${errors.join(" | ")}`);
  await browser.close();
})();
