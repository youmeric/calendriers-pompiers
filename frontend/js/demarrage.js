/* Guide de démarrage d'une nouvelle caserne (version multi-casernes) : identité, association,
   communes et secteurs, lancement de la tournée. S'ouvre tout seul tant qu'il n'est pas terminé. */
(() => {
  "use strict";
  const { escapeHtml, fetchJSON, showToast } = window.Common;
  const $ = (id) => document.getElementById(id);
  const STEPS = [
    { key: "identite", titre: "Votre caserne" },
    { key: "association", titre: "Association et contact" },
    { key: "secteurs", titre: "Communes et secteurs" },
    { key: "equipe", titre: "Lancer la tournée" },
  ];
  let ctx = { can: () => false, onSectors: () => {} };
  let st = null;
  let settings = null;
  let step = 0;

  const send = (url, method, body) => fetchJSON(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const val = (id) => ($(id) ? $(id).value.trim() : "");

  async function load() {
    [st, settings] = await Promise.all([fetchJSON("/api/admin/demarrage"), fetchJSON("/api/admin/settings")]);
  }

  function renderSteps() {
    $("dm-steps").innerHTML = STEPS.map((s, i) => `<li class="${i === step ? "current" : ""}${st.etapes[s.key] ? " done" : ""}">
      <button type="button" data-step="${i}"><span>${st.etapes[s.key] ? "✓" : i + 1}</span>${escapeHtml(s.titre)}</button></li>`).join("");
  }

  function render() {
    renderSteps();
    $("dm-error").hidden = true;
    $("dm-prev").hidden = step === 0;
    $("dm-next").textContent = step === STEPS.length - 1 ? "Terminer ✓" : "Suivant →";
    const b = $("dm-body");
    if (step === 0) {
      b.innerHTML = `<p>Ces réglages donnent au site les couleurs de votre caserne : site public, espace équipe sur les téléphones, plans imprimés, reçus.</p>
        <label class="field">Nom affiché<input id="dm-nom" maxlength="120" value="${escapeHtml(settings.caserne_nom || "")}" /></label>
        <div class="dm-row">
          <label class="field">Couleur principale<input id="dm-couleur" type="color" value="${escapeHtml(settings.caserne_couleur || "#e5383b")}" /></label>
          <div class="brand-logo-row"><img id="dm-logo" src="${escapeHtml(settings.caserne_logo)}" alt="Logo" width="58" height="80" />
            <div><label class="btn small brand-upload">Choisir votre logo<input type="file" id="dm-logo-file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden /></label>
            <p class="hint">L'écusson de la caserne (PNG, JPEG, WebP ou SVG, 1 Mo au plus).</p></div></div>
        </div>`;
      $("dm-logo-file").addEventListener("change", uploadLogo);
    } else if (step === 1) {
      b.innerHTML = `<p>Ces informations figurent sur les <b>reçus</b>, les <b>mentions légales</b> et le <b>dossier comptable</b>.</p>
        <label class="field">Association<input id="dm-asso" maxlength="150" value="${escapeHtml(settings.asso_nom || "")}" placeholder="Amicale des sapeurs-pompiers de …" /></label>
        <label class="field">Adresse<input id="dm-adresse" maxlength="300" value="${escapeHtml(settings.asso_adresse || "")}" placeholder="Caserne, code postal, commune" /></label>
        <div class="dm-row">
          <label class="field">E-mail de contact<input id="dm-email" type="email" maxlength="150" value="${escapeHtml(settings.contact_email || "")}" /></label>
          <label class="field">Téléphone de contact<input id="dm-tel" maxlength="40" value="${escapeHtml(settings.contact_tel || "")}" /></label>
        </div>
        <label class="field">N° RNA / SIRET (facultatif)<input id="dm-siret" maxlength="40" value="${escapeHtml(settings.asso_siret || "")}" /></label>`;
    } else if (step === 2) {
      const cs = st.communes;
      const missing = cs.filter((c) => !c.secteurs && c.proposes);
      b.innerHTML = !cs.length
        ? `<div class="warning warn"><div class="warning-body">${st.generation === "en_cours"
            ? "⏳ Les adresses et les routes de vos communes sont en cours de téléchargement (quelques minutes)."
            : "Aucune commune pour l'instant : l'administrateur de la plateforme doit d'abord les ajouter."}</div></div>
           <button type="button" class="btn" id="dm-refresh">Actualiser</button>`
        : `<p>Les adresses (Base Adresse Nationale) et les routes de vos communes sont prêtes.</p>
           <table class="bilan-table dm-communes"><thead><tr><th>Commune</th><th>Maisons</th><th>Secteurs</th></tr></thead><tbody>
           ${cs.map((c) => `<tr><td><b>${escapeHtml(c.nom)}</b></td><td>${c.adresses}</td><td>${c.secteurs ? `✓ ${c.secteurs}` : `<span class="hint">aucun (${c.proposes} proposés)</span>`}</td></tr>`).join("")}
           </tbody></table>
           ${missing.length ? `<p>Pour démarrer vite, créez les <b>secteurs proposés automatiquement</b> (équilibrés, le bourg à pied depuis la mairie). Vous pourrez ensuite les redessiner, les couper ou les fusionner dans l'onglet <b>Secteurs</b>.</p>
             <button type="button" class="btn primary" id="dm-sectors"${ctx.can("secteurs") ? "" : " disabled"}>Créer les secteurs proposés</button>`
             : `<p class="dm-ok">✓ Chaque commune a ses secteurs. Retouchez-les quand vous voulez dans l'onglet <b>Secteurs</b>.</p>`}`;
      if ($("dm-refresh")) $("dm-refresh").addEventListener("click", async () => { await load(); render(); });
      if ($("dm-sectors")) $("dm-sectors").addEventListener("click", createSectors);
    } else {
      b.innerHTML = `<div class="dm-row">
          <label class="field">Année de la tournée<input id="dm-annee" type="number" min="2000" max="2100" value="${st.annee}" /></label>
        </div>
        <label class="setting-row"><input type="checkbox" id="dm-suivi"${st.suivi ? " checked" : ""} /><span><b>Suivi des maisons</b> : les équipes marquent sur leur téléphone les maisons faites, absentes, refusées</span></label>
        <label class="setting-row"><input type="checkbox" id="dm-dons"${st.dons ? " checked" : ""} /><span><b>Enregistrer les dons</b> (espèces, chèques, carte) : caisse par équipe et dossier comptable</span></label>
        <p><b>Ensuite :</b></p>
        <ol class="dm-next">
          <li class="${st.personnes ? "done" : ""}">Onglet <b>Équipes</b> : ajoutez les personnes de la tournée${st.personnes ? ` (${st.personnes} déjà)` : ""} et placez-les dans les secteurs.</li>
          <li>Envoyez à chacun son <b>code d'accès</b> (bouton « Envoyer les accès » : WhatsApp, SMS ou lien).</li>
          <li>Imprimez les <b>plans de secteur</b> si vous le souhaitez (bouton « Plan » de chaque secteur).</li>
        </ol>`;
    }
  }

  async function uploadLogo() {
    const file = $("dm-logo-file").files[0];
    if (!file) return;
    if (file.size > 1_000_000) { showToast("Image trop lourde (1 Mo au plus).", true); return; }
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    try {
      const res = await send("/api/admin/logo", "PUT", { type: file.type, data });
      $("dm-logo").src = res.logo;
      document.querySelectorAll(".brand-logo, .login-logo").forEach((img) => { img.src = res.logo; });
      settings.caserne_logo = res.logo;
      st.etapes.identite = true;
      renderSteps();
      showToast("Logo enregistré ✓");
    } catch (err) { showToast(err.message, true); }
  }

  async function createSectors() {
    $("dm-sectors").disabled = true;
    try {
      st = await send("/api/admin/demarrage/secteurs", "POST", {});
      showToast(st.crees.length ? `Secteurs créés : ${st.crees.join(", ")} ✓` : "Rien à créer");
      ctx.onSectors();
      render();
    } catch (err) { showToast(err.message, true); $("dm-sectors").disabled = false; }
  }

  /** Enregistre l'étape affichée ; false si une saisie est à corriger. */
  async function saveStep() {
    if (step === 0) {
      const nom = val("dm-nom");
      if (!nom) throw new Error("Indiquez le nom de la caserne.");
      settings = await send("/api/admin/settings", "PUT", { caserne_nom: nom, caserne_couleur: $("dm-couleur").value });
      document.querySelectorAll(".topbar-sub").forEach((el) => { el.textContent = nom; });
    } else if (step === 1) {
      settings = await send("/api/admin/settings", "PUT", {
        asso_nom: val("dm-asso"), asso_adresse: val("dm-adresse"), contact_email: val("dm-email"),
        contact_tel: val("dm-tel"), asso_siret: val("dm-siret"),
      });
    } else if (step === 3) {
      const annee = Number(val("dm-annee"));
      settings = await send("/api/admin/settings", "PUT", { annee, suivi_adresses: $("dm-suivi").checked, dons_actifs: $("dm-dons").checked && $("dm-suivi").checked });
      st = await send("/api/admin/demarrage/fin", "POST", {});
      return;
    }
    st = await fetchJSON("/api/admin/demarrage");
  }

  async function go(next) {
    try {
      if (next > step || next === STEPS.length) await saveStep();
    } catch (err) {
      $("dm-error").textContent = err.message;
      $("dm-error").hidden = false;
      return;
    }
    if (next >= STEPS.length) {
      $("dm-dialog").close();
      showToast("C'est prêt ! Bonne tournée 🚒");
      ctx.onSectors();
      return;
    }
    step = Math.max(0, next);
    render();
  }

  async function open(at = null) {
    await load();
    step = at ?? Math.max(0, STEPS.findIndex((s) => !st.etapes[s.key]));
    if (step < 0 || step >= STEPS.length) step = 0;
    render();
    $("dm-dialog").showModal();
  }

  $("dm-form").addEventListener("submit", (e) => { e.preventDefault(); go(step + 1); }); // Entrée = Suivant
  $("dm-next").addEventListener("click", () => go(step + 1));
  $("dm-prev").addEventListener("click", () => go(step - 1));
  $("dm-later").addEventListener("click", () => $("dm-dialog").close());
  $("dm-steps").addEventListener("click", (e) => {
    const b = e.target.closest("[data-step]");
    if (b) go(Number(b.dataset.step));
  });
  $("btn-demarrage").addEventListener("click", () => open().catch((err) => showToast(err.message, true)));

  window.Demarrage = {
    /** Après la connexion : bouton du guide pour une caserne de la plateforme, ouverture tant que pas terminé. */
    async init(options) {
      ctx = { ...ctx, ...options };
      if (!ctx.can("reglages")) { $("btn-demarrage").hidden = true; return; }
      const c = await fetchJSON("/api/public/caserne");
      $("btn-demarrage").hidden = !c.multi;
      if (!c.multi) return;
      const s = await fetchJSON("/api/admin/demarrage");
      if (!s.fait && !$("dm-dialog").open) await open();
    },
  };
})();
