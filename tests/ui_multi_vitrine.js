// Site vitrine d'Almaneo (domaine « localhost » en test) : page, formulaire de démo, arrivée dans l'admin central.
const { chromium, devices } = require("playwright");
const SP = process.env.TEST_DIR || require("os").tmpdir();
const PORT = (process.env.TEST_URL || "http://127.0.0.1:8123").split(":").pop();
const VITRINE = `http://localhost:${PORT}`;
const CENTRAL = `http://127.0.0.1:${PORT}`;
function check(c, m) { console.log(`${c ? "OK  " : "FAIL"} ${m}`); if (!c) process.exitCode = 1; }
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, n) => p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));
  const v = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage(); watch(v, "vitrine");
  await v.goto(`${VITRINE}/`); await v.waitForTimeout(800);
  check((await v.textContent("h1")).includes("Votre tournée") && await v.locator(".v-pillars article").count() === 4
    && await v.locator(".v-finance-grid article").count() === 6 && await v.locator("#securite article").count() === 6
    && (await v.textContent(".v-footer")).includes("votrecaserne."), "vitrine : accroche, étapes, finances, 6 points de sécurité, accès des casernes existantes");
  // on descend toute la page pour charger les images différées, comme un visiteur
  await v.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); });
  await v.waitForTimeout(800);
  check(await v.evaluate(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0)), "toutes les images s'affichent");
  await v.screenshot({ path: `${SP}/vitrine-ordinateur.png`, fullPage: true });
  await v.click('.v-nav a[href="#contact"]'); await v.waitForTimeout(400);
  await v.click('#v-form button[type="submit"]'); await v.waitForTimeout(300);
  check((await v.textContent("#v-msg")).includes("Indiquez votre nom"), "formulaire incomplet : message clair");
  await v.fill('[name="nom"]', "Marc Dupuis"); await v.fill('[name="caserne"]', "Amicale des sapeurs-pompiers de Vaugneray");
  await v.fill('[name="email"]', "marc@exemple.fr"); await v.fill('[name="message"]', "Tournée en novembre");
  await v.fill('[name="commune"]', "Vaugneray, Grézieu"); await v.fill('[name="equipiers"]', "25");
  await v.click('#v-form button[type="submit"]'); await v.waitForTimeout(800);
  check((await v.textContent("#v-msg")).includes("Merci"), "demande envoyée : confirmation");
  const m = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage(); watch(m, "mobile");
  await m.goto(`${VITRINE}/`); await m.waitForTimeout(800);
  check(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "téléphone : pas de défilement horizontal");
  await m.screenshot({ path: `${SP}/vitrine-telephone.png`, fullPage: true });
  const p = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage(); watch(p, "central");
  await p.goto(`${CENTRAL}/plateforme`); await p.fill("#pf-password", "central-secret"); await p.click('#pf-login-form button[type="submit"]'); await p.waitForTimeout(1000);
  check((await p.textContent("#pf-demandes")).includes("Amicale des sapeurs-pompiers de Vaugneray") && (await p.textContent("#pf-dem-count")).includes("1 nouvelle")
    && (await p.textContent("#pf-demandes")).includes("Vaugneray, Grézieu") && (await p.textContent("#pf-demandes")).includes("25 équipiers"),
    "admin central : la demande est arrivée");
  await p.click('#pf-demandes [data-dem="1"]'); await p.waitForTimeout(600);
  check(await p.isHidden("#pf-dem-count"), "demande traitée");
  // tarifs : affichés depuis l'admin central, puis choisis sur la vitrine
  check(await v.locator("#tarifs").count() === 0, "tarifs cachés au départ");
  await p.click('.pf-nav a[href="#tarifs"]'); await p.waitForTimeout(300);
  check(await p.locator(".pf-offre").count() === 3, "admin central : 3 formules proposées au départ");
  await p.fill('.pf-offre[data-i="1"] [data-o="prix"]', "139 €");
  await p.check("#pf-tarifs-actif"); await p.click("#pf-tarifs-save"); await p.waitForTimeout(800);
  await p.screenshot({ path: `${SP}/pf-tarifs.png` });
  await v.reload(); await v.waitForTimeout(800);
  check(await v.locator("#tarifs .v-price-card").count() === 3 && (await v.textContent("#tarifs")).includes("139 €"), "vitrine : les 3 formules, avec le prix modifié");
  await v.locator("#tarifs").scrollIntoViewIfNeeded(); await v.waitForTimeout(300);
  await v.screenshot({ path: `${SP}/vitrine-tarifs.png` });
  await v.click('#tarifs [data-offre="Amicale"]'); await v.waitForTimeout(600);
  check(await v.inputValue('#v-form select[name="offre"]') === "Amicale", "« Choisir Amicale » : formule présélectionnée dans la demande");
  await v.fill('[name="nom"]', "Paule Martin"); await v.fill('[name="caserne"]', "Amicale de Montclar"); await v.fill('[name="email"]', "paule@exemple.fr");
  await v.click('#v-form button[type="submit"]'); await v.waitForTimeout(800);
  await p.reload(); await p.waitForTimeout(1200);
  check((await p.textContent("#pf-demandes")).includes("Formule : Amicale"), "admin central : la demande indique la formule");
  check(errors.length === 0, `aucune erreur JS ${errors.join(" | ")}`);
  await browser.close();
})();
