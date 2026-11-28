// Fiche d'une maison : une note tapée est enregistrée d'elle-même quand on appuie ensuite sur « Fait »
// (ou qu'on ferme la fiche), sans passer par « Enregistrer la note ».
const { chromium, devices } = require("playwright");
const B = process.env.TEST_URL || "http://127.0.0.1:8123";
function check(c, m) { console.log(`${c ? "OK  " : "FAIL"} ${m}`); if (!c) process.exitCode = 1; }
(async () => {
  const browser = await chromium.launch();
  const a = await (await browser.newContext()).newPage();
  await a.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r) => r.abort());
  await a.goto(`${B}/admin`); await a.fill("#password", "secret123"); await a.click("#login-form button");
  await a.waitForSelector("#editor-view:not([hidden])");
  const req = a.request;
  await req.put(`${B}/api/admin/settings`, { data: { suivi_adresses: true } });
  const autos = (await (await req.get(`${B}/api/admin/communes/courzieu`)).json()).auto_sectors;
  const secs = (await (await req.put(`${B}/api/admin/communes/courzieu/sectors`, { data: { sectors: autos } })).json()).sectors;
  const [jean] = (await (await req.post(`${B}/api/admin/personnes`, { data: { personnes: [{ nom: "Jean Dupont" }] } })).json()).personnes;
  await req.put(`${B}/api/admin/secteurs/${secs[0].id}/equipe`, { data: { membres: [{ personne_id: jean.id, role: "responsable" }] } });

  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r) => r.abort());
  await p.goto(`${B}/equipe#acces=${jean.code}`); await p.waitForTimeout(1500);
  await p.click('.t-tabs a[data-tab="maisons"]'); await p.click('.t-filter[data-filter="all"]'); await p.waitForTimeout(300);
  const rows = p.locator(".t-row");
  const label1 = (await rows.nth(0).locator(".t-row-label").textContent()).trim();
  const label2 = (await rows.nth(1).locator(".t-row-label").textContent()).trim();
  const open = async (label) => { await p.locator(".t-row", { hasText: label }).first().locator(".t-row-main").click(); await p.waitForTimeout(300); };

  // 1. note tapée, puis « Fait » directement
  await open(label1);
  await p.fill("#tf-note", "Chien méchant");
  await p.click('#t-fiche .tf-status .tt-btn[data-status="fait"]'); await p.waitForTimeout(1000);
  // 2. note tapée, puis la fiche fermée
  await open(label2);
  await p.fill("#tf-note", "Repasser le soir");
  await p.click("#tf-close"); await p.waitForTimeout(1000);

  // tout est bien sur le serveur : on recharge la page
  await p.reload(); await p.waitForTimeout(1500);
  await p.click('.t-tabs a[data-tab="maisons"]'); await p.click('.t-filter[data-filter="all"]'); await p.waitForTimeout(300);
  await open(label1);
  check(await p.inputValue("#tf-note") === "Chien méchant", "note tapée puis « Fait » : enregistrée");
  check((await p.locator("#t-fiche .tt-btn.fait").getAttribute("class")).includes("active"), "… et la maison est bien marquée faite");
  await p.click("#tf-close"); await p.waitForTimeout(300);
  await open(label2);
  check(await p.inputValue("#tf-note") === "Repasser le soir", "note tapée puis fiche fermée : enregistrée");
  await p.click("#tf-close"); await p.waitForTimeout(300);
  check(await p.locator(".t-row", { hasText: label2 }).first().locator(".note-chip").count() === 1, "la note apparaît dans la liste des maisons");
  // 3. ouvrir et fermer sans rien changer : pas de nouvelle note ni de message
  await open(label1);
  await p.click("#tf-close"); await p.waitForTimeout(600);
  check(!(await p.isVisible("#toast")) || !(await p.textContent("#toast")).includes("Note"), "fiche fermée sans changement : rien n'est renvoyé");
  check(errors.length === 0, `aucune erreur JS ${errors.join(" | ")}`);
  await browser.close();
})();
