// Captures de l'application pour le site vitrine (frontend/img/vitrine/), sur une caserne fictive.
// Usage : serveur lancé avec les communes de démonstration (fake_data.py --demo), puis
//   NODE_PATH=$(npm root -g) node tests/captures_vitrine.js <dossier de sortie>
const { chromium, devices } = require("playwright");
const OUT = process.argv[2] || ".";
const B = process.env.TEST_URL || "http://127.0.0.1:8123";
const fs = require("fs");
(async () => {
  const browser = await chromium.launch();
  const a = await (await browser.newContext({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2 })).newPage();
  await a.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r) => r.abort());
  a.on("dialog", (d) => d.accept());
  await a.goto(`${B}/admin`); await a.fill("#password", "secret123"); await a.click("#login-form button");
  await a.waitForSelector("#editor-view:not([hidden])");
  const req = a.request;
  const logo = fs.readFileSync(`${__dirname}/../frontend/img/logo-generique.svg`).toString("base64");
  await req.put(`${B}/api/admin/logo`, { data: { type: "image/svg+xml", data: logo } });
  await req.put(`${B}/api/admin/settings`, { data: { suivi_adresses: true, dons_actifs: true, caserne_nom: "Sapeurs-pompiers de Valmont", avancement: "terminees" } });
  const noms = ["Julien Martin", "Sophie Bernard", "Thomas Petit", "Camille Durand", "Nicolas Leroy", "Laura Moreau", "Antoine Simon", "Chloé Laurent",
    "Maxime Lefebvre", "Emma Michel", "Hugo Garcia", "Léa Roux"];
  const people = (await (await req.post(`${B}/api/admin/personnes`, { data: { personnes: noms.map((nom, i) => ({ nom, telephone: `06 12 34 56 ${String(10 + i)}` })) } })).json()).personnes;
  const secs = [];
  for (const slug of ["valmont", "les-aubiers"]) {
    const autos = (await (await req.get(`${B}/api/admin/communes/${slug}`)).json()).auto_sectors;
    secs.push(...(await (await req.put(`${B}/api/admin/communes/${slug}/sectors`, { data: { sectors: autos } })).json()).sectors.map((s) => ({ ...s, slug })));
  }
  for (let i = 0; i < secs.length; i++) {
    const m = [{ personne_id: people[(2 * i) % people.length].id, role: "responsable" }, { personne_id: people[(2 * i + 1) % people.length].id, role: "equipier" }];
    await req.put(`${B}/api/admin/secteurs/${secs[i].id}/equipe`, { data: { membres: m, date: "2026-11-29", creneau: "matin", statut: i < 3 ? "en_cours" : "a_faire" } });
  }
  // une tournée bien avancée : maisons faites, absents, quelques refus, des dons
  const pub = {};
  for (const slug of ["valmont", "les-aubiers"]) pub[slug] = (await (await req.get(`${B}/api/communes/${slug}`)).json()).sectors;
  const progress = [0.72, 0.55, 0.38, 0.12, 0.6, 0.25];
  let k = 0;
  const montants = [10, 10, 15, 20, 10, 5, 15, 10, 20, 30, 10, 12];
  for (const [i, s] of secs.entries()) {
    const sector = pub[s.slug].find((x) => x.id === s.id);
    const resp = people[(2 * i) % people.length];
    const ctx = await browser.newContext();
    const t = ctx.request;
    await t.post(`${B}/api/equipe/login`, { data: { code: resp.code } });
    const n = Math.round(sector.addresses.length * progress[i % progress.length]);
    for (const [j, adr] of sector.addresses.slice(0, n).entries()) {
      const r = (j * 37) % 100;
      const status = r < 8 ? "absent" : r < 12 ? "refus" : "fait";
      if (status === "fait" && r % 3 !== 0) {
        await t.post(`${B}/api/equipe/dons`, { data: { slug: s.slug, address_id: adr.id, montant: montants[k++ % montants.length], mode: k % 5 === 0 ? "cheque" : k % 7 === 0 ? "cb" : "especes" } });
      } else {
        await t.post(`${B}/api/communes/${s.slug}/addresses/${encodeURIComponent(adr.id)}/status`, { data: { status } });
      }
    }
    await ctx.close();
  }
  // 1. suivi en direct (admin)
  await a.reload(); await a.waitForSelector("#editor-view:not([hidden])"); await a.waitForTimeout(800);
  await a.screenshot({ path: `${OUT}/admin-secteurs.png` });
  await a.click('.admin-tab[data-tab="bilan"]'); await a.waitForTimeout(1800);
  await a.evaluate(() => document.querySelector(".bilan-main").scrollIntoView());
  await a.screenshot({ path: `${OUT}/admin-suivi.png` });
  // 2. téléphone du responsable du secteur 1
  const p = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
  await p.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r) => r.abort());
  await p.goto(`${B}/equipe#acces=${people[0].code}`); await p.waitForTimeout(1800);
  await p.screenshot({ path: `${OUT}/phone-accueil.png` });
  await p.click('.t-tabs a[data-tab="maisons"]'); await p.click('.t-filter[data-filter="all"]'); await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/phone-maisons.png` });
  await p.click('.t-tabs a[data-tab="carte"]'); await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/phone-carte.png` });
  await browser.close();
  console.log("captures faites dans", OUT);
})();
