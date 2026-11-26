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
  await c.waitForFunction(() => document.querySelector("#commune-select").options.length > 0, null, { timeout: 10000 }).catch(() => {});
  check(await c.isVisible("#editor-view") && (await c.textContent("#commune-select")).includes("Courzieu"), "admin de la caserne : connexion et communes (données de test)");
  await c.screenshot({ path: `${SP}/pf-caserne-admin.png` });
  check((await c.getAttribute(".brand-logo", "src")) === "/img/logo-generique.svg" && (await c.textContent(".topbar-sub")) === "Sapeurs-pompiers de Vaugneray",
    "admin de la caserne : son nom et un logo neutre");
  // guide de démarrage : s'ouvre tout seul à la première connexion
  await c.waitForTimeout(800);
  check(await c.isVisible("#dm-dialog") && (await c.textContent("#dm-steps")).includes("Votre caserne"), "guide de démarrage ouvert à la première connexion");
  await c.screenshot({ path: `${SP}/dm-1-identite.png` });
  await c.click("#dm-next"); await c.waitForTimeout(500);
  await c.fill("#dm-adresse", "Caserne, 69670 Vaugneray"); await c.fill("#dm-email", "chef@exemple.fr");
  await c.click("#dm-next"); await c.waitForTimeout(700);
  check((await c.textContent("#dm-steps li:nth-child(2)")).includes("✓"), "étape association faite");
  check(await c.isVisible("#dm-sectors"), "communes prêtes : bouton « Créer les secteurs proposés »");
  await c.click("#dm-sectors"); await c.waitForTimeout(1500);
  check((await c.textContent("#dm-body")).includes("Chaque commune a ses secteurs"), "secteurs proposés créés");
  await c.screenshot({ path: `${SP}/dm-3-secteurs.png` });
  await c.click("#dm-next"); await c.waitForTimeout(500);
  await c.check("#dm-suivi"); await c.check("#dm-dons");
  await c.click("#dm-next"); await c.waitForTimeout(1200);
  check(!(await c.isVisible("#dm-dialog")), "guide terminé");
  check(await c.locator(".sector-edit-card").count() === 4, "éditeur : les secteurs créés apparaissent");
  await c.reload(); await c.waitForTimeout(1500);
  check(!(await c.isVisible("#dm-dialog")) && await c.isVisible("#btn-demarrage"), "guide terminé : ne s'ouvre plus, reste accessible");
  // identité : nom, couleur, logo
  await c.click('.admin-tab[data-tab="bilan"]'); await c.waitForTimeout(1200);
  await c.evaluate(() => { document.getElementById("brand-group").open = true; });
  await c.fill('[data-setting="caserne_nom"]', "Centre de secours de Vaugneray"); await c.press('[data-setting="caserne_nom"]', "Tab");
  await c.locator('[data-setting="caserne_couleur"]').fill("#0f766e"); await c.waitForTimeout(400);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  await c.setInputFiles("#brand-logo-file", { name: "ecusson.png", mimeType: "image/png", buffer: png }); await c.waitForTimeout(900);
  check((await c.getAttribute("#brand-logo-preview", "src")).startsWith("/logo?v=") && await c.isVisible("#brand-logo-reset"), "logo envoyé depuis l'admin");
  await c.screenshot({ path: `${SP}/pf-identite.png`, fullPage: false });
  const pub = await (await browser.newContext({ viewport: { width: 400, height: 800 } })).newPage(); watch(pub, "public");
  await pub.route(/tile\.openstreetmap\.org|data\.geopf\.fr|fonts\.g/, (r) => r.abort());
  await pub.goto(`${CASERNE}/`); await pub.waitForTimeout(1200);
  const accent = await pub.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  check((await pub.textContent(".topbar-sub")) === "Centre de secours de Vaugneray" && (await pub.getAttribute(".brand-logo", "src")).startsWith("/logo?v=") && accent === "#0f766e",
    "site public : nouveau nom, logo et couleur");
  // la couleur de la caserne passe partout (boutons, liens), jamais le rouge Almaneo par-dessus
  const red = await pub.evaluate(() => [...document.querySelectorAll(".btn.primary, a")].filter((el) => el.offsetParent)
    .map((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]).flat().filter((c) => c === "rgb(227, 20, 27)" || c === "rgb(184, 15, 22)").length);
  check(red === 0, `site public : aucun bouton ni lien resté au rouge Almaneo (${red})`);
  await pub.goto(`${CASERNE}/equipe`); await pub.waitForTimeout(1200);
  const redTeam = await pub.evaluate(() => [...document.querySelectorAll(".btn.primary, a")].filter((el) => el.offsetParent)
    .map((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]).flat().filter((c) => c === "rgb(227, 20, 27)" || c === "rgb(184, 15, 22)").length);
  check(redTeam === 0, `espace équipe : couleur de la caserne sur les boutons et liens (${redTeam})`);
  const html = await pub.content();
  check(html.includes('alt="Centre de secours de Vaugneray"') && !html.includes("Sapeurs-pompiers de Courzieu"), "espace équipe : identité de la caserne");
  await pub.screenshot({ path: `${SP}/pf-equipe-login.png` });
  const other = await (await browser.newContext()).newPage();
  await other.goto(`${CENTRAL}/plateforme`); // la session de la caserne ne donne pas accès à l'admin central
  check(await other.isVisible("#pf-login"), "l'admin central reste protégé");

  // suspension depuis l'admin central (fenêtre « Gérer »)
  await p.click('.pf-caserne [data-act="gerer"]'); await p.waitForTimeout(300);
  check(await p.isVisible("#pf-manage") && (await p.textContent("#pf-m-title")).includes("Vaugneray"), "fenêtre « Gérer » de la caserne");
  await p.screenshot({ path: `${SP}/pf-gerer.png` });
  await p.click('#pf-manage [data-act="suspendue"]'); await p.waitForTimeout(800);
  check((await p.textContent(".pf-caserne .pf-badge")).includes("Suspendue"), "caserne suspendue");
  const status = () => c.evaluate(() => fetch("/api/communes").then((r) => r.status));
  check(await status() === 503, "son site ne répond plus");
  await p.click('#pf-manage [data-act="active"]'); await p.waitForTimeout(800);
  check(await status() === 200, "réactivée");
  // bot WhatsApp de la caserne, géré par l'admin central
  await p.check('#pf-manage [data-f="whatsapp_actif"]'); await p.click('#pf-manage [data-act="bot"]'); await p.waitForTimeout(700);
  check((await p.textContent(".pf-caserne .pf-chips")).includes("Bot WhatsApp"), "bot WhatsApp activé pour la caserne");
  await p.keyboard.press("Escape"); await p.waitForTimeout(200);
  // exploitation : comptes de l'admin central, export, archivage et suppression
  await p.fill("#pf-a-ident", "marie"); await p.fill("#pf-a-nom", "Marie Durand"); await p.fill("#pf-a-pwd", "un-long-mot-de-passe");
  await p.click('#pf-compte-form button[type="submit"]'); await p.waitForTimeout(800);
  check((await p.textContent("#pf-comptes")).includes("Marie Durand"), "compte de l'admin central ajouté");
  const m = await (await browser.newContext()).newPage(); watch(m, "marie");
  await m.goto(`${CENTRAL}/plateforme`); await m.fill("#pf-ident", "marie"); await m.fill("#pf-password", "un-long-mot-de-passe");
  await m.click('#pf-login-form button[type="submit"]'); await m.waitForTimeout(900);
  check((await m.textContent("#pf-me")) === "Marie Durand" && await m.isVisible("#pf-list"), "Marie se connecte avec son compte");
  await p.click('.pf-caserne [data-act="gerer"]'); await p.waitForTimeout(300);
  const [download] = await Promise.all([p.waitForEvent("download"), p.click('#pf-manage a[href$="/export"]')]);
  check(/^caserne-vaugneray-.*\.zip$/.test(download.suggestedFilename()), `export téléchargé (${download.suggestedFilename()})`);
  await p.screenshot({ path: `${SP}/pf-exploitation.png`, fullPage: true });
  await p.click('#pf-manage [data-act="archivee"]'); await p.waitForTimeout(800);
  p.removeAllListeners("dialog");
  p.on("dialog", (d) => d.accept(d.type() === "prompt" ? "vaugneray" : undefined));
  await p.click('#pf-manage [data-act="supprimer"]'); await p.waitForTimeout(900);
  check((await p.textContent("#pf-summary")).includes("Aucune caserne"), "caserne archivée puis supprimée");
  const jr = await p.textContent("#pf-journal");
  check(jr.includes("caserne.suppression") && jr.includes("— Administrateur principal") && jr.includes("— Marie Durand"), "journal de la plateforme : qui a fait quoi");
  check(errors.length === 0, `aucune erreur JS ${errors.join(" | ")}`);
  await browser.close();
})();
