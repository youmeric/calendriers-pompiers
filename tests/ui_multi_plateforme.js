// Version multi-casernes : admin central (création d'une caserne, communes, suspension) puis admin de la caserne.
// Lancé par run_tests.sh avec PLATFORM_DB_PATH (serveur en mode multi-casernes, domaine « localhost »).
const { chromium } = require("playwright");
const SP = process.env.TEST_DIR || require("os").tmpdir();
const PORT = (process.env.TEST_URL || "http://127.0.0.1:8123").split(":").pop();
const CENTRAL = `http://127.0.0.1:${PORT}`;
const CASERNE = `http://vaugneray.localhost:${PORT}`;
function check(c, m) { console.log(`${c ? "OK  " : "FAIL"} ${m}`); if (!c) process.exitCode = 1; }
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, n) => {
    p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_|status of 40[13]/.test(m.text())) errors.push(`${n}: ${m.text()}`); });
  };
  const p = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage(); watch(p, "central");
  p.on("dialog", (d) => d.accept());
  await p.goto(`${CENTRAL}/`); await p.waitForTimeout(800);
  check(p.url().endsWith("/plateforme") && await p.isVisible("#pf-login"), "adresse de la plateforme : connexion de l'admin central");
  await p.fill("#pf-password", "central-secret"); await p.click('#pf-login-form button[type="submit"]'); await p.waitForTimeout(800);
  check(await p.isVisible("#pf-app") && (await p.textContent("#pf-summary")).includes("Aucune caserne"), "admin central : aucune caserne");
  await p.click("#pf-new");
  await p.fill("#pf-c-nom", "Sapeurs-pompiers de Vaugneray");
  check(await p.inputValue("#pf-c-slug") === "vaugneray", "identifiant proposé d'après le nom");
  await p.fill("#pf-c-ident", "chef.vaugneray"); await p.fill("#pf-c-anom", "Paul Chef"); await p.fill("#pf-c-pwd", "motdepasse1");
  await p.fill("#pf-c-communes", "Vaugneray, 69670");
  await p.screenshot({ path: `${SP}/pf-creation.png` });
  await p.click('#pf-create-form button[type="submit"]'); await p.waitForTimeout(1000);
  for (let i = 0; i < 30 && (await p.textContent("#pf-list")).includes("en cours"); i++) await p.waitForTimeout(1000);
  const card = await p.textContent(".pf-caserne");
  check(card.includes("Sapeurs-pompiers de Vaugneray") && card.includes("Communes prêtes") && card.includes("vaugneray.localhost"), "caserne créée, communes prêtes, adresse affichée");
  await p.screenshot({ path: `${SP}/pf-liste.png`, fullPage: true });

  // la caserne se débrouille seule
  const c = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage(); watch(c, "caserne");
  await c.goto(`${CASERNE}/admin`); await c.waitForTimeout(800);
  await c.fill("#login-id", "chef.vaugneray"); await c.fill("#password", "motdepasse1"); await c.click("#login-form button");
  await c.waitForSelector("#editor-view:not([hidden])", { timeout: 10000 }).catch(() => {});
  check(await c.isVisible("#editor-view") && (await c.textContent("#commune-select")).includes("Courzieu"), "admin de la caserne : connexion et communes (données de test)");
  await c.screenshot({ path: `${SP}/pf-caserne-admin.png` });
  const other = await (await browser.newContext()).newPage();
  await other.goto(`${CENTRAL}/plateforme`); // la session de la caserne ne donne pas accès à l'admin central
  check(await other.isVisible("#pf-login"), "l'admin central reste protégé");

  // suspension depuis l'admin central
  await p.click(".pf-caserne .pf-edit summary");
  await p.click('.pf-caserne [data-act="suspendue"]'); await p.waitForTimeout(800);
  check((await p.textContent(".pf-caserne .pf-badge")).includes("Suspendue"), "caserne suspendue");
  const status = () => c.evaluate(() => fetch("/api/communes").then((r) => r.status));
  check(await status() === 503, "son site ne répond plus");
  await p.click(".pf-caserne .pf-edit summary").catch(() => {});
  await p.click('.pf-caserne [data-act="active"]'); await p.waitForTimeout(800);
  check(await status() === 200, "réactivée");
  check(errors.length === 0, `aucune erreur JS ${errors.join(" | ")}`);
  await browser.close();
})();
