const { chromium, devices } = require("playwright");
const SP = process.env.TEST_DIR || require("os").tmpdir(); // captures d'écran
const B = process.env.TEST_URL || "http://127.0.0.1:8123";
function check(c, m) { console.log(`${c ? "OK  " : "FAIL"} ${m}`); if (!c) process.exitCode = 1; }
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, n) => {
    p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_/.test(m.text())) errors.push(`${n}: ${m.text()}`); });
  };
  const a = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); watch(a, "admin");
  await a.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r) => r.abort());
  a.on("dialog", (d) => d.accept());
  await a.goto(`${B}/admin`); await a.fill("#password", "secret123"); await a.click("#login-form button");
  await a.waitForSelector("#editor-view:not([hidden])");
  const req = a.request;
  const autos = (await (await req.get(`${B}/api/admin/communes/courzieu`)).json()).auto_sectors;
  const secs = (await (await req.put(`${B}/api/admin/communes/courzieu/sectors`, { data: { sectors: autos } })).json()).sectors;
  const [jean] = (await (await req.post(`${B}/api/admin/personnes`, { data: { personnes: [{ nom: "Jean Dupont" }] } })).json()).personnes;
  await req.put(`${B}/api/admin/secteurs/${secs[0].id}/equipe`, { data: { membres: [{ personne_id: jean.id, role: "responsable" }] } });
  await req.put(`${B}/api/admin/settings`, { data: { suivi_adresses: true } });
  const pub = async () => (await (await req.get(`${B}/api/communes/courzieu`)).json()).sectors.find((s) => s.id === secs[0].id).addresses;
  const [h0, h1] = await pub();
  // h0 exclue pour pouvoir centrer la carte dessus (bouton « Voir »), puis corrigée
  await req.put(`${B}/api/admin/communes/courzieu/excluded`, { data: { address_ids: [h0.id], excluded: true } });
  await a.reload(); await a.waitForSelector("#editor-view:not([hidden])"); await a.waitForTimeout(800);
  await a.evaluate(() => { document.querySelectorAll("details").forEach((d) => { if (d.querySelector("#excluded-list")) d.open = true; }); });
  await a.locator("#excluded-list .excluded-row button", { hasText: "Voir" }).first().click(); await a.waitForTimeout(800);
  const box = await a.locator("#admin-map").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await a.mouse.click(cx, cy); await a.waitForTimeout(400);
  check(await a.locator(".leaflet-popup button", { hasText: "Corriger l'adresse" }).count() === 1, "Secteurs : clic sur la maison → « Corriger l'adresse »");
  await a.locator(".leaflet-popup button", { hasText: "Corriger l'adresse" }).click(); await a.waitForTimeout(300);
  check(await a.inputValue('.corr-box [data-f="numero"]') === h0.numero && await a.inputValue('.corr-box [data-f="nom_voie"]') === h0.nom_voie, "formulaire pré-rempli");
  await a.fill('.corr-box [data-f="numero"]', "12 bis");
  await a.fill('.corr-box [data-f="nom_voie"]', "Rue des Écoles");
  await a.locator(".leaflet-popup button", { hasText: "Déplacer le point" }).click(); await a.waitForTimeout(300);
  check(await a.evaluate(() => document.querySelector("#admin-map").classList.contains("picking-point")), "déplacer : curseur en croix");
  await a.mouse.click(cx + 80, cy + 40); await a.waitForTimeout(400);
  check(await a.isVisible(".corr-moved") && await a.inputValue('.corr-box [data-f="numero"]') === "12 bis", "nouveau point placé, saisie gardée");
  await a.screenshot({ path: `${SP}/corr-admin-popup.png` });
  await a.locator(".leaflet-popup button", { hasText: "Enregistrer la correction" }).click(); await a.waitForTimeout(800);
  const adm = (await (await req.get(`${B}/api/admin/communes/courzieu`)).json()).addresses.find((x) => x.id === h0.id);
  check(adm.label === "12 bis Rue des Écoles" && adm.corrigee && Math.abs(adm.lat - h0.lat) > 0.00005, `enregistré : « ${adm.label} », point déplacé`);
  // rouvrir sur le nouveau point : origine affichée, retour possible
  await a.mouse.click(cx + 80, cy + 40); await a.waitForTimeout(400);
  const pop = await a.textContent(".leaflet-popup");
  check(pop.includes("12 bis Rue des Écoles") && pop.includes(`origine : ${h0.label}`), "popup : adresse corrigée + origine");
  await a.locator(".leaflet-popup button", { hasText: "Corriger l'adresse" }).click(); await a.waitForTimeout(300);
  await a.locator(".leaflet-popup button", { hasText: "Revenir à l'adresse d'origine" }).click(); await a.waitForTimeout(800);
  const back = (await (await req.get(`${B}/api/admin/communes/courzieu`)).json()).addresses.find((x) => x.id === h0.id);
  check(back.label === h0.label && !back.corrigee && back.lat === h0.lat, "retour à l'adresse d'origine");

  // signalement « adresse fausse » corrigé depuis Suivi & dons
  const jr = (await browser.newContext()).request;
  await jr.post(`${B}/api/equipe/login`, { data: { code: jean.code } });
  await jr.post(`${B}/api/equipe/signalements`, { data: { slug: "courzieu", type: "erreur", address_id: h1.id, note: "c'est le 14" } });
  await a.click('.admin-tab[data-tab="bilan"]'); await a.waitForTimeout(1200);
  const row = a.locator("#sig-list .sig-item").first();
  check(await row.locator('[data-f="numero"]').inputValue() === h1.numero && await row.locator('[data-f="nom_voie"]').inputValue() === h1.nom_voie, "signalement : numéro et rue pré-remplis");
  await row.locator('[data-f="numero"]').fill("14");
  await a.screenshot({ path: `${SP}/corr-signalement.png` });
  await row.locator('[data-act="corriger"]').click(); await a.waitForTimeout(1000);
  const h1b = (await pub()).find((x) => x.id === h1.id);
  check(h1b.label === `14 ${h1.nom_voie}`, `signalement corrigé : « ${h1b.label} »`);
  check((await a.textContent("#sig-list")).includes("Aucun signalement en attente"), "signalement passé en traité");

  // l'équipe voit la nouvelle adresse
  const j = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage(); watch(j, "jean");
  await j.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r) => r.abort());
  await j.goto(`${B}/equipe#acces=${jean.code}`); await j.waitForTimeout(1600);
  await j.click('.t-tabs a[data-tab="maisons"]'); await j.waitForTimeout(300);
  check((await j.textContent(`.t-row[data-id="${h1.id}"]`)).includes(`14 ${h1.nom_voie}`), "équipe : nouvelle adresse dans la liste");
  check(errors.length === 0, `aucune erreur JS ${errors.join(" | ")}`);
  await browser.close();
})();
