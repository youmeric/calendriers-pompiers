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
  check((await v.textContent("h1")).includes("La tournée des calendriers") && await v.locator(".v-grid article").count() === 8, "vitrine : accroche et 8 fonctions");
  check(await v.evaluate(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0)), "toutes les images s'affichent");
  await v.screenshot({ path: `${SP}/vitrine-ordinateur.png`, fullPage: true });
  await v.click('.v-nav a[href="#contact"]'); await v.waitForTimeout(400);
  await v.click('#v-form button[type="submit"]'); await v.waitForTimeout(300);
  check((await v.textContent("#v-msg")).includes("Indiquez votre nom"), "formulaire incomplet : message clair");
  await v.fill('[name="nom"]', "Marc Dupuis"); await v.fill('[name="caserne"]', "Amicale des sapeurs-pompiers de Vaugneray");
  await v.fill('[name="email"]', "marc@exemple.fr"); await v.fill('[name="message"]', "3 communes, 8 équipes, tournée en novembre");
  await v.click('#v-form button[type="submit"]'); await v.waitForTimeout(800);
  check((await v.textContent("#v-msg")).includes("Merci"), "demande envoyée : confirmation");
  const m = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage(); watch(m, "mobile");
  await m.goto(`${VITRINE}/`); await m.waitForTimeout(800);
  check(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "téléphone : pas de défilement horizontal");
  await m.screenshot({ path: `${SP}/vitrine-telephone.png`, fullPage: true });
  const p = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage(); watch(p, "central");
  await p.goto(`${CENTRAL}/plateforme`); await p.fill("#pf-password", "central-secret"); await p.click('#pf-login-form button[type="submit"]'); await p.waitForTimeout(1000);
  check((await p.textContent("#pf-demandes")).includes("Amicale des sapeurs-pompiers de Vaugneray") && (await p.textContent("#pf-dem-count")).includes("1 nouvelle"),
    "admin central : la demande est arrivée");
  await p.click('#pf-demandes [data-dem="1"]'); await p.waitForTimeout(600);
  check(await p.isHidden("#pf-dem-count"), "demande traitée");
  check(errors.length === 0, `aucune erreur JS ${errors.join(" | ")}`);
  await browser.close();
})();
