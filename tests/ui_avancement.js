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
  const s1 = secs[0];
  const [jean] = (await (await req.post(`${B}/api/admin/personnes`, { data: { personnes: [{ nom: "Jean Dupont" }] } })).json()).personnes;
  await req.put(`${B}/api/admin/secteurs/${s1.id}/equipe`, { data: { membres: [{ personne_id: jean.id, role: "responsable" }] } });
  await req.put(`${B}/api/admin/settings`, { data: { suivi_adresses: true, dons_actifs: true } });
  const pub = await (await req.get(`${B}/api/communes/courzieu`)).json();
  const addrs = pub.sectors.find((s) => s.id === s1.id).addresses;
  const n = addrs.length;
  const jr = (await browser.newContext()).request;
  await jr.post(`${B}/api/equipe/login`, { data: { code: jean.code } });
  const marks = ["fait", "fait", "fait", "absent", "absent", "refus"];
  for (let i = 0; i < marks.length; i++) await jr.post(`${B}/api/communes/courzieu/addresses/${encodeURIComponent(addrs[i].id)}/status`, { data: { status: marks[i] } });
  const want = { passees: Math.round((6 / n) * 100), terminees: Math.round((4 / n) * 100), faites: Math.round((3 / n) * 100) };
  const tot = pub.sectors.reduce((x, s) => x + s.addresses.length, 0);
  const wantAll = { passees: Math.round((6 / tot) * 100), terminees: Math.round((4 / tot) * 100), faites: Math.round((3 / tot) * 100) };
  console.log("attendu", want, "sur", n, "· commune", wantAll, "sur", tot);

  await a.click('.admin-tab[data-tab="bilan"]'); await a.waitForTimeout(1200);
  check(await a.isVisible("#avancement-select") && await a.inputValue("#avancement-select") === "passees", "admin : réglage visible, « passées » par défaut");
  const card = async () => a.textContent("#bilan-cards .bilan-card");
  check((await card()).includes(`${wantAll.passees} %`) && (await card()).includes(`6 passées / ${tot}`), `admin : avancement ${want.passees} % (absents comptés)`);
  await a.screenshot({ path: `${SP}/av-admin-passees.png` });
  await a.selectOption("#avancement-select", "terminees"); await a.waitForTimeout(1200);
  check((await card()).includes(`${wantAll.terminees} %`) && (await card()).includes(`4 terminées / ${tot}`), `admin : « terminées » ${want.terminees} % (absents à repasser non comptés)`);
  check((await a.textContent(".live-label")).includes(`${want.terminees} %`), `carte en direct : C1 à ${want.terminees} %`);
  check((await a.textContent(".live-label .prov-text")).includes(`${want.passees} %`), `carte en direct : provisoire ${want.passees} % en transparence`);
  check((await a.textContent("#bilan-cards .bilan-card .prov-text")).includes(`${wantAll.passees} % provisoire · 2 à repasser`), "carte Avancement : provisoire et à repasser");
  check((await a.textContent("#bilan-body tr")).includes(`(${want.passees} % provisoire)`) && await a.locator("#bilan-body tr .bilan-progress span.prov").count() === 1, "tableau : barre provisoire transparente");
  await a.screenshot({ path: `${SP}/av-admin-terminees.png` });
  check((await a.textContent("#bilan-body tr")).includes(`${want.terminees} %`) && (await a.textContent(".bilan-total-row")).includes(`${wantAll.terminees} % · 4 terminées / ${tot}`), "tableau : par secteur et total");
  await a.selectOption("#avancement-select", "faites"); await a.waitForTimeout(1200);
  check((await card()).includes(`${wantAll.faites} %`) && (await card()).includes(`3 faites / ${tot}`), `admin : « faites seulement » ${want.faites} %`);
  await a.screenshot({ path: `${SP}/av-admin-faites.png` });
  await a.reload(); await a.waitForTimeout(2500);
  check(await a.inputValue("#avancement-select") === "faites", "admin : réglage gardé après rechargement");

  // appli équipe
  const j = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage(); watch(j, "jean");
  await j.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r) => r.abort());
  await j.goto(`${B}/equipe#acces=${jean.code}`); await j.waitForTimeout(1800);
  const pct = async () => (await j.textContent(".r-pct")).replace(/\s/g, "");
  check(await pct() === `${want.faites}%` && (await j.textContent(".r-progress-text")).includes(`3 / ${n}`) && (await j.textContent(".r-progress-text")).includes("maisons faites"), `équipe : ${want.faites} % · 3 / ${n} maisons faites`);
  await j.screenshot({ path: `${SP}/av-equipe-faites.png` });
  await req.put(`${B}/api/admin/settings`, { data: { avancement: "terminees" } });
  await j.reload(); await j.waitForTimeout(1800);
  check(await pct() === `${want.terminees}%` && (await j.textContent(".r-progress-text")).includes("maisons terminées"), `équipe : « terminées » ${want.terminees} %`);
  check((await j.textContent(".r-progress-text .prov-text")) === `${want.passees} % provisoire · 2 à repasser` && await j.locator(".r-ring-prov").count() === 1, "équipe : provisoire en transparence (anneau + texte)");
  await j.screenshot({ path: `${SP}/av-equipe-terminees.png` });
  await req.put(`${B}/api/admin/settings`, { data: { avancement: "passees" } });
  await j.reload(); await j.waitForTimeout(1800);
  check(await pct() === `${want.passees}%` && (await j.textContent(".r-progress-text")).includes("maisons passées") && await j.locator(".r-ring-prov, .r-progress-text .prov-text").count() === 0, `équipe : « passées » ${want.passees} %, pas de provisoire`);
  // aperçu admin dans l'appli équipe (toutes les tournées)
  const ap = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage(); watch(ap, "admin-tel");
  await ap.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r) => r.abort());
  await ap.goto(`${B}/admin`); await ap.fill("#password", "secret123"); await ap.click("#login-form button"); await ap.waitForTimeout(800);
  await req.put(`${B}/api/admin/settings`, { data: { avancement: "terminees" } });
  await ap.goto(`${B}/equipe`); await ap.waitForTimeout(2000);
  const ov = await ap.locator(".ov-card").count() ? await ap.textContent(".ov-card") : "";
  check(ov.includes(`${want.terminees} %`) && ov.includes("maisons terminées") && ov.includes("2 à repasser") && await ap.locator(".ov-bar i.prov").count() === 1, "aperçu de toutes les tournées : même calcul + provisoire");
  await ap.screenshot({ path: `${SP}/av-apercu.png` });
  check(errors.length === 0, `aucune erreur JS ${errors.join(" | ")}`);
  await browser.close();
})();
