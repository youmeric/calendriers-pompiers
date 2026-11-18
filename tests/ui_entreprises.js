// Tournée des entreprises : admin (liste, renommer, retirer, ajouter sur la carte), signalement par une équipe, appli de l'équipe entreprises.
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
  const block = (p) => p.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r) => r.abort());
  const a = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); watch(a, "admin"); await block(a);
  a.on("dialog", (d) => d.accept());
  await a.goto(`${B}/admin`); await a.fill("#password", "secret123"); await a.click("#login-form button");
  await a.waitForSelector("#editor-view:not([hidden])");
  const req = a.request;
  const autos = (await (await req.get(`${B}/api/admin/communes/courzieu`)).json()).auto_sectors;
  const secs = (await (await req.put(`${B}/api/admin/communes/courzieu/sectors`, { data: { sectors: autos } })).json()).sectors;
  const s1 = secs[0];
  const [jean, eve] = (await (await req.post(`${B}/api/admin/personnes`, { data: { personnes: [{ nom: "Jean Dupont" }, { nom: "Eve Martin" }] } })).json()).personnes;
  await req.put(`${B}/api/admin/secteurs/${s1.id}/equipe`, { data: { membres: [{ personne_id: jean.id, role: "responsable" }] } });
  await req.put(`${B}/api/admin/settings`, { data: { suivi_adresses: true, dons_actifs: true } });
  const pub = async () => (await (await req.get(`${B}/api/communes/courzieu`)).json()).sectors;
  const [h0, h1] = (await pub()).find((s) => s.id === s1.id).addresses;
  await req.put(`${B}/api/admin/communes/courzieu/addresses/${h0.id}/entreprise`, { data: { nom: "Garage" } });

  // admin : liste des entreprises, renommer, retirer, ajouter sur la carte
  await a.reload(); await a.waitForSelector("#editor-view:not([hidden])"); await a.waitForTimeout(800);
  await a.evaluate(() => { document.getElementById("ent-block").open = true; });
  check((await a.textContent("#ent-count")) === "1" && (await a.textContent("#ent-list")).includes("Garage"), "Secteurs : liste des entreprises");
  await a.locator("#ent-list button", { hasText: "Voir" }).click(); await a.waitForTimeout(500);
  await a.fill('.corr-box [data-f="nom"]', "Garage Martin");
  await a.locator(".leaflet-popup button", { hasText: "Enregistrer le nom" }).click(); await a.waitForTimeout(700);
  check((await a.textContent("#ent-list")).includes("Garage Martin"), "entreprise renommée");
  // clic sur la carte (la vue est centrée sur l'entreprise) : popup avec les infos entreprise
  const box = await a.locator("#admin-map").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await a.mouse.click(cx, cy); await a.waitForTimeout(400);
  check((await a.textContent(".leaflet-popup")).includes("🏢 Garage Martin"), "popup de l'adresse : nom de l'entreprise");
  await a.screenshot({ path: `${SP}/ent-admin-popup.png` });
  await a.keyboard.press("Escape");
  await a.click("#ent-add"); await a.waitForTimeout(200);
  await a.mouse.click(cx + 120, cy - 60); await a.waitForTimeout(400);
  await a.fill('.corr-box [data-f="nom"]', "Menuiserie Roux");
  await a.fill('.corr-box [data-f="nom_voie"]', "ZA des Platanes");
  await a.locator(".leaflet-popup button", { hasText: "Ajouter à la tournée des entreprises" }).click(); await a.waitForTimeout(900);
  check((await a.textContent("#ent-count")) === "2" && (await a.textContent("#ent-list")).includes("Menuiserie Roux"), "entreprise ajoutée sur la carte");
  let ent = (await pub()).find((s) => s.kind === "entreprises");
  check(ent && ent.addresses.length === 2 && ent.addresses.some((x) => x.entreprise === "Menuiserie Roux" && x.label === "ZA des Platanes"), "site : tournée « Entreprises » avec les 2 entreprises");
  await a.screenshot({ path: `${SP}/ent-admin-liste.png` });

  // équipe : signale une entreprise oubliée
  const j = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage(); watch(j, "jean"); await block(j);
  await j.goto(`${B}/equipe#acces=${jean.code}`); await j.waitForTimeout(1600);
  await j.click('.t-tabs a[data-tab="maisons"]'); await j.waitForTimeout(300);
  check(await j.locator(`.t-row[data-id="${h0.id}"]`).count() === 0, "équipe du secteur : l'entreprise n'est plus dans sa liste");
  await j.locator(`.t-row[data-id="${h1.id}"] [data-open]`).first().click(); await j.waitForTimeout(400);
  await j.click("#tf-sig"); await j.waitForTimeout(300);
  check(await j.isHidden("#sig-ent-field"), "signalement : nom caché tant que « entreprise » n'est pas choisi");
  await j.click('#sig-type-ent input'); await j.waitForTimeout(100);
  check(await j.isVisible("#sig-ent-field"), "« C'est une entreprise » : champ du nom");
  await j.fill("#sig-ent-nom", "Boulangerie Dupont");
  await j.screenshot({ path: `${SP}/ent-signalement.png` });
  await j.click('#sig-form button[type="submit"]'); await j.waitForTimeout(800);
  // admin : valide le signalement
  await a.click('.admin-tab[data-tab="bilan"]'); await a.waitForTimeout(1200);
  const row = a.locator("#sig-list .sig-item").first();
  check((await row.textContent()).includes("C'est une entreprise") && await row.locator('[data-f="entreprise"]').inputValue() === "Boulangerie Dupont", "admin : signalement « entreprise » avec le nom");
  await a.screenshot({ path: `${SP}/ent-admin-signalement.png` });
  await row.locator('[data-act="entreprise"]').click(); await a.waitForTimeout(1000);
  ent = (await pub()).find((s) => s.kind === "entreprises");
  check(ent.addresses.some((x) => x.id === h1.id && x.entreprise === "Boulangerie Dupont"), "signalement validé : ajoutée à la tournée des entreprises");
  const bil = await a.textContent("#bilan-body");
  check(bil.includes("Entreprises"), "suivi : ligne de la tournée « Entreprises »");

  // appli de l'équipe entreprises
  await req.put(`${B}/api/admin/secteurs/${ent.id}/equipe`, { data: { membres: [{ personne_id: eve.id, role: "responsable" }] } });
  const e = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage(); watch(e, "eve"); await block(e);
  await e.goto(`${B}/equipe#acces=${eve.code}`); await e.waitForTimeout(1600);
  check((await e.textContent("header")).includes("Entreprises"), "équipe entreprises : sa tournée « Entreprises »");
  await e.click('.t-tabs a[data-tab="maisons"]'); await e.waitForTimeout(300);
  const list = await e.textContent("#t-list");
  check(list.includes("🏢 Garage Martin") && list.includes("🏢 Boulangerie Dupont") && list.includes("🏢 Menuiserie Roux"), "équipe entreprises : les 3 entreprises avec leur nom");
  await e.screenshot({ path: `${SP}/ent-equipe-liste.png` });
  await e.locator(`.t-row[data-id="${h1.id}"] [data-open]`).first().click(); await e.waitForTimeout(400);
  check((await e.textContent("#tf-title")) === "🏢 Boulangerie Dupont" && (await e.textContent("#tf-sub")).includes(h1.label), "fiche : nom de l'entreprise et adresse");
  await e.click("#tf-close");
  await e.click('.t-tabs a[data-tab="carte"]'); await e.waitForTimeout(800);
  await e.screenshot({ path: `${SP}/ent-equipe-carte.png` });

  // retirer : retour dans le secteur
  await req.delete(`${B}/api/admin/communes/courzieu/addresses/${h0.id}/entreprise`);
  check((await pub()).find((s) => s.id === s1.id).addresses.some((x) => x.id === h0.id), "retirée : de retour dans son secteur");
  // les autres pages connaissent la tournée des entreprises
  await a.click('.admin-tab[data-tab="equipes"]'); await a.waitForTimeout(1200);
  check((await a.textContent("#equipes-view, main")).includes("Entreprises"), "onglet Équipes : la tournée « Entreprises » (pour lui donner une équipe)");
  const pubPage = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage(); watch(pubPage, "public"); await block(pubPage);
  await pubPage.goto(`${B}/`); await pubPage.waitForTimeout(1500);
  const plan = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage(); watch(plan, "plan"); await block(plan);
  await plan.goto(`${B}/plan.html#/courzieu/${ent.id}`); await plan.waitForTimeout(2000);
  check((await plan.textContent("body")).includes("Entreprises"), "plan imprimable de la tournée des entreprises");
  await plan.screenshot({ path: `${SP}/ent-plan.png` });
  check(errors.length === 0, `aucune erreur JS ${errors.join(" | ")}`);
  await browser.close();
})();
