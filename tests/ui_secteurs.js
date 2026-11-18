// Secteurs modifiés en pleine tournée : dons reçus par l'ancienne équipe (appli), avertissement admin.
const { chromium, devices } = require("playwright");
const SP = process.env.TEST_DIR || require("os").tmpdir(); // captures d'écran
const B = process.env.TEST_URL || "http://127.0.0.1:8123";
function check(c, m) { console.log(`${c ? "OK  " : "FAIL"} ${m}`); if (!c) process.exitCode = 1; }
const square = (lat, lon, d = 0.00005) => [[[lat - d, lon - d], [lat - d, lon + d], [lat + d, lon + d], [lat + d, lon - d]]];
const norm = (p) => (Array.isArray(p[0][0][0]) ? p : Array.isArray(p[0][0]) ? p.map((r) => [r]) : [[p]]);
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
  await a.selectOption("#commune-select", "courzieu").catch(() => {}); await a.waitForTimeout(600);
  await a.evaluate(() => { document.getElementById("btn-import-auto").closest("details").open = true; });
  await a.click("#btn-import-auto"); await a.click("#btn-save"); await a.waitForTimeout(900);
  check(!(await a.isVisible("#impact-dialog")), "premier enregistrement (rien de passé) : pas d'avertissement");
  const req = a.request;
  const [jean, paul] = (await (await req.post(`${B}/api/admin/personnes`, { data: { personnes: [{ nom: "Jean Dupont" }, { nom: "Paul Martin" }] } })).json()).personnes;
  const pub = await (await req.get(`${B}/api/communes/courzieu`)).json();
  const [s1, s2] = pub.sectors;
  await req.put(`${B}/api/admin/secteurs/${s1.id}/equipe`, { data: { membres: [{ personne_id: jean.id, role: "responsable" }] } });
  await req.put(`${B}/api/admin/secteurs/${s2.id}/equipe`, { data: { membres: [{ personne_id: paul.id, role: "responsable" }] } });
  await req.put(`${B}/api/admin/settings`, { data: { suivi_adresses: true, dons_actifs: true } });
  const jr = (await browser.newContext()).request;
  await jr.post(`${B}/api/equipe/login`, { data: { code: jean.code } });
  const [h0, h1] = s1.addresses;
  await jr.post(`${B}/api/communes/courzieu/addresses/${encodeURIComponent(h0.id)}/status`, { data: { status: "fait" } });
  await jr.post(`${B}/api/equipe/dons`, { data: { slug: "courzieu", address_id: h0.id, montant: 10, mode: "especes" } });
  await jr.post(`${B}/api/communes/courzieu/addresses/${encodeURIComponent(h1.id)}/status`, { data: { status: "absent" } });
  // la maison h0 passe dans le secteur de Paul
  const adm = await (await req.get(`${B}/api/admin/communes/courzieu`)).json();
  const secs = adm.sectors.map((s) => ({ id: s.id, nom: s.nom, couleur: s.couleur, polygon: s.polygon }));
  const i2 = secs.findIndex((s) => s.id === s2.id);
  const moved = { ...secs[i2], polygon: [...norm(secs[i2].polygon), square(h0.lat, h0.lon)] };
  check((await req.put(`${B}/api/admin/communes/courzieu/sectors`, { data: { sectors: [moved, ...secs.filter((s) => s.id !== s2.id)] } })).ok(), "maison déplacée dans le secteur de Paul");

  // Paul voit le don reçu par l'équipe de Jean
  const p = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage(); watch(p, "paul");
  await p.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r2) => r2.abort());
  await p.goto(`${B}/equipe#acces=${paul.code}`); await p.waitForTimeout(1600);
  await p.click('.t-tabs a[data-tab="maisons"]'); await p.click('.t-filter[data-filter="all"]'); await p.waitForTimeout(200);
  const row = p.locator(`.t-row[data-id="${h0.id}"]`);
  check(await row.count() === 1 && (await row.getAttribute("class")).includes("st-fait"), "Paul : la maison arrive « faite »");
  const badge = await row.locator(".don-badge.other").textContent();
  check(badge.includes("10 €") && badge.includes("reçu par") && badge.includes(s1.nom), `Paul : badge « ${badge.trim()} »`);
  await row.locator("[data-don]").click(); await p.waitForTimeout(300);
  const other = await p.textContent("#don-existing .don-line.other");
  check(other.includes("Reçu par l'équipe") && other.includes("pas la vôtre") && await p.locator("#don-existing .don-line.other button").count() === 0, "Paul : don de l'autre équipe en lecture seule");
  await p.screenshot({ path: `${SP}/secteurs-don-autre-equipe.png` });
  await p.click("#don-dialog [data-close]");
  await p.click('.t-tabs a[data-tab="caisse"]'); await p.waitForTimeout(300);
  check(!(await p.textContent("#v-caisse")).includes("10 €"), "Paul : pas dans sa caisse");

  // supprimer le secteur de Jean en pleine tournée -> avertissement
  await a.reload(); await a.waitForSelector("#editor-view:not([hidden])");
  await a.selectOption("#commune-select", "courzieu").catch(() => {}); await a.waitForTimeout(800);
  const order = (await (await req.get(`${B}/api/communes/courzieu`)).json()).sectors.map((s) => s.id);
  await a.locator(".sector-edit-card").nth(order.indexOf(s1.id)).locator("button", { hasText: "Supprimer" }).click(); await a.waitForTimeout(200);
  await a.click("#btn-save"); await a.waitForTimeout(900);
  check(await a.isVisible("#impact-dialog"), "admin : avertissement avant d'enregistrer");
  const txt = await a.textContent("#impact-dialog");
  check(txt.includes(h1.label) && txt.includes("à repasser") && txt.includes("maison déjà passée"), "avertissement : maison à repasser listée");
  check(txt.includes(`Le secteur ${s1.nom} est supprimé`) && txt.includes("1 personne") && txt.includes("10 €"), "avertissement : équipe et dons du secteur supprimé");
  await a.screenshot({ path: `${SP}/secteurs-avertissement.png` });
  await a.click('#impact-dialog button[value="cancel"]'); await a.waitForTimeout(500);
  let cur = await (await req.get(`${B}/api/communes/courzieu`)).json();
  check(cur.sectors.some((s) => s.id === s1.id), "Annuler : rien n'est enregistré");
  await a.click("#btn-save"); await a.waitForTimeout(900);
  await a.click("#impact-ok"); await a.waitForTimeout(1200);
  cur = await (await req.get(`${B}/api/communes/courzieu`)).json();
  check(!cur.sectors.some((s) => s.id === s1.id), "« Enregistrer quand même » : enregistré");
  const journal = await (await req.get(`${B}/api/admin/journal`)).json();
  check(journal.entrees.some((x) => x.action === "secteurs.supprime") && journal.entrees.some((x) => x.action === "secteurs.maisons"), "journal : secteur supprimé et maisons déplacées");
  check(errors.length === 0, `aucune erreur JS ${errors.join(" | ")}`);
  await browser.close();
})();
