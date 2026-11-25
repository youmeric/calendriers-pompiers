/* Admin central de la plateforme multi-casernes : créer et gérer les casernes. */
(() => {
  "use strict";
  const { escapeHtml, fetchJSON, showToast, euros } = window.Common;
  const $ = (id) => document.getElementById(id);
  const STATUT = { active: "Active", suspendue: "Suspendue", archivee: "Archivée" };
  const FORMULE = { gratuit: "Gratuit", essai: "Essai", actif: "Abonnement actif", expire: "Expiré" };
  let state = { casernes: [], abos: false, domaine: "" };

  const api = async (url, opts = {}) => {
    try {
      return await fetchJSON(url, opts.body ? { ...opts, headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body) } : opts);
    } catch (err) {
      if (err.status === 401) showLogin();
      throw err;
    }
  };

  function showLogin() {
    $("pf-login").hidden = false;
    $("pf-app").hidden = true;
    $("pf-logout").hidden = true;
  }

  async function start() {
    try {
      const me = await fetchJSON("/api/plateforme/moi");
      state.domaine = me.domaine;
      state.moi = me.moi;
      $("pf-me").textContent = me.moi.nom;
      $("pf-me").hidden = false;
    } catch { showLogin(); return; }
    $("pf-login").hidden = true;
    $("pf-app").hidden = false;
    $("pf-logout").hidden = false;
    await refresh();
  }

  async function refresh() {
    const r = await api("/api/plateforme/casernes");
    state.casernes = r.casernes;
    state.abos = r.abonnements_actifs;
    $("pf-abos").checked = state.abos;
    render();
    const dm = (await api("/api/plateforme/demandes")).demandes;
    const open = dm.filter((d) => !d.traitee).length;
    $("pf-dem-count").hidden = !open;
    $("pf-dem-count").textContent = `${open} nouvelle${open > 1 ? "s" : ""}`;
    $("pf-demandes").innerHTML = dm.length ? dm.map((d) => `<div class="pf-demande${d.traitee ? " off" : ""}" data-id="${d.id}">
        <div><b>${escapeHtml(d.caserne)}</b> — ${escapeHtml(d.nom)}
          <small class="hint">${new Date(d.created_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</small><br>
          <a href="mailto:${encodeURIComponent(d.email).replace(/%40/g, "@")}">${escapeHtml(d.email)}</a>${d.telephone ? ` · ${escapeHtml(d.telephone)}` : ""}
          ${d.message ? `<p class="pf-dem-msg">${escapeHtml(d.message)}</p>` : ""}</div>
        <button type="button" class="btn small" data-dem="${d.traitee ? "0" : "1"}">${d.traitee ? "Rouvrir" : "✓ Traitée"}</button></div>`).join("")
      : `<p class="hint">Aucune demande pour l'instant.</p>`;
    const cp = await api("/api/plateforme/comptes");
    $("pf-comptes").innerHTML = cp.comptes.length ? cp.comptes.map((a) => `<div class="pf-compte${a.actif ? "" : " off"}" data-id="${a.id}">
        <span><b>${escapeHtml(a.nom)}</b> <small class="hint">${escapeHtml(a.identifiant)}${a.actif ? "" : " · désactivé"}</small></span>
        <span><button type="button" class="btn small" data-cpt="pwd">Nouveau mot de passe</button>
        ${state.moi && state.moi.id === a.id ? "" : `<button type="button" class="btn small" data-cpt="${a.actif ? "off" : "on"}">${a.actif ? "Désactiver" : "Réactiver"}</button>`}</span></div>`).join("")
      : `<p class="hint">Aucun compte nominatif : seul le compte principal existe.</p>`;
    const j = await api("/api/plateforme/journal");
    $("pf-journal").innerHTML = j.entrees.length ? j.entrees.slice(0, 50).map((e) => `<div class="pf-jr">
        <span>${new Date(e.at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span>
        <b>${escapeHtml(e.action)}</b> ${escapeHtml(e.objet)} <small class="hint">${escapeHtml(e.details)}</small> <small class="pf-qui">— ${escapeHtml(e.qui)}</small></div>`).join("")
      : `<p class="hint">Rien pour l'instant.</p>`;
    // une génération en cours : on revient voir dans un moment
    if (state.casernes.some((c) => c.generation && c.generation.statut === "en_cours")) setTimeout(() => refresh().catch(() => {}), 8000);
  }

  function genLine(g) {
    if (!g) return `<span class="pf-warn">Communes pas encore téléchargées</span>`;
    const noms = g.communes.map((c) => c.nom).join(", ");
    if (g.statut === "en_cours") return `<span class="pf-run">⏳ Téléchargement en cours : ${escapeHtml(noms)}</span>`;
    if (g.statut === "echec") return `<span class="pf-ko">✕ Échec du téléchargement (${escapeHtml(noms)})</span> <details><summary>détails</summary><pre>${escapeHtml(g.message)}</pre></details>`;
    return `<span class="pf-ok">✓ Communes prêtes : ${escapeHtml(noms)}</span>`;
  }

  function render() {
    const n = state.casernes.length;
    $("pf-summary").textContent = n ? `${n} caserne${n > 1 ? "s" : ""} · ${state.casernes.filter((c) => c.statut === "active").length} active(s)` : "Aucune caserne pour l'instant.";
    $("pf-list").innerHTML = state.casernes.map((c) => {
      const s = c.stats;
      const abo = c.abonnement;
      return `<article class="card pf-caserne st-${c.statut}" data-id="${c.id}">
        <header><h2>${escapeHtml(c.nom)}</h2><span class="pf-badge st-${c.statut}">${STATUT[c.statut]}</span></header>
        <p class="hint">${escapeHtml(c.slug)} · ${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.url)}</a>` : "aucune adresse : à régler"}</p>
        <p>${genLine(c.generation)}${s.communes.length && !(c.generation && c.generation.statut === "en_cours") ? ` <small class="hint">(${s.communes.map(escapeHtml).join(", ")})</small>` : ""}</p>
        <p class="pf-stats">${s.comptes} compte(s) console · ${s.personnes} personne(s) · ${s.secteurs} secteur(s) · ${s.dons} don(s) ${s.annee} : <b>${euros(s.total)}</b>
          ${s.derniere_activite ? ` · dernière activité ${new Date(s.derniere_activite).toLocaleDateString("fr-FR")}` : ""}
          · ${s.derniere_sauvegarde ? `dernière sauvegarde ${new Date(s.derniere_sauvegarde).toLocaleDateString("fr-FR")}` : `<span class="pf-warn">pas encore de sauvegarde</span>`}</p>
        ${state.abos ? `<p class="pf-abo ${abo.actif ? "" : "pf-ko"}">Abonnement : <b>${FORMULE[c.abonnement_formule]}</b>${c.abonnement_fin ? ` jusqu'au ${new Date(c.abonnement_fin).toLocaleDateString("fr-FR")}` : ""}${abo.actif ? "" : " — expiré"}</p>` : ""}
        <details class="pf-edit"><summary>Gérer</summary>
          <label class="field">Nom<input data-f="nom" value="${escapeHtml(c.nom)}" maxlength="120" /></label>
          <label class="field">Adresse(s) du site (une par ligne)<textarea data-f="hosts" rows="2">${escapeHtml(c.hosts.join("\n"))}</textarea></label>
          ${state.abos ? `<div class="field-row">
            <label class="field">Formule<select data-f="abonnement">${Object.entries(FORMULE).map(([k, v]) => `<option value="${k}"${k === c.abonnement_formule ? " selected" : ""}>${v}</option>`).join("")}</select></label>
            <label class="field">Fin<input type="date" data-f="abonnement_fin" value="${escapeHtml(c.abonnement_fin || "")}" /></label></div>` : ""}
          <div class="pf-actions">
            <button type="button" class="btn small primary" data-act="save">Enregistrer</button>
            ${c.statut === "active" ? `<button type="button" class="btn small" data-act="suspendue">Suspendre</button>` : `<button type="button" class="btn small" data-act="active">Réactiver</button>`}
            ${c.statut !== "archivee" ? `<button type="button" class="btn small danger" data-act="archivee">Archiver</button>` : ""}
            <a class="btn small" href="/api/plateforme/casernes/${c.id}/export" download>⬇ Exporter toutes les données</a>
            ${c.statut === "archivee" ? `<button type="button" class="btn small danger" data-act="supprimer">Supprimer définitivement</button>` : ""}
          </div>
          <label class="field">Communes à télécharger (une par ligne : Nom, code postal)<textarea data-f="communes" rows="2" placeholder="Courzieu, 69690"></textarea></label>
          <button type="button" class="btn small" data-act="communes">Télécharger les communes</button>
          <fieldset class="pf-fieldset"><legend>Ajouter un compte administrateur (ex. mot de passe perdu)</legend>
            <div class="field-row"><label class="field">Identifiant<input data-f="a_ident" maxlength="60" autocapitalize="none" /></label>
            <label class="field">Nom<input data-f="a_nom" maxlength="80" /></label></div>
            <label class="field">Mot de passe provisoire<input data-f="a_pwd" minlength="8" maxlength="200" autocomplete="new-password" /></label>
            <button type="button" class="btn small" data-act="compte">Créer le compte</button>
          </fieldset>
        </details>
      </article>`;
    }).join("");
  }

  function parseCommunes(text) {
    return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(.+?)[,;\s]+(\d{5})$/);
      if (!m) throw new Error(`Commune illisible : « ${l} » (attendu : Nom, code postal)`);
      return { nom: m[1].trim(), code_postal: m[2] };
    });
  }
  const lines = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);

  $("pf-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const card = btn.closest(".pf-caserne");
    const id = card.dataset.id;
    const v = (f) => (card.querySelector(`[data-f="${f}"]`) || {}).value || "";
    const act = btn.dataset.act;
    try {
      if (act === "save") {
        const body = { nom: v("nom").trim(), hosts: lines(v("hosts")) };
        if (state.abos) Object.assign(body, { abonnement: v("abonnement"), abonnement_fin: v("abonnement_fin") });
        await api(`/api/plateforme/casernes/${id}`, { method: "PUT", body });
        showToast("Enregistré ✓");
      } else if (["active", "suspendue", "archivee"].includes(act)) {
        const msg = { suspendue: "Suspendre cette caserne ? Son site et son appli ne répondront plus (données gardées).",
          archivee: "Archiver cette caserne ? Son site est fermé et ses sauvegardes automatiques s'arrêtent (données gardées).", active: "" }[act];
        if (msg && !confirm(msg)) return;
        await api(`/api/plateforme/casernes/${id}`, { method: "PUT", body: { statut: act } });
        showToast(`Caserne ${STATUT[act].toLowerCase()} ✓`);
      } else if (act === "communes") {
        await api(`/api/plateforme/casernes/${id}/communes`, { method: "POST", body: { communes: parseCommunes(v("communes")) } });
        showToast("Téléchargement lancé : quelques minutes…");
      } else if (act === "supprimer") {
        const { slug } = state.casernes.find((x) => String(x.id) === id);
        const typed = prompt(`Suppression DÉFINITIVE de toutes les données de cette caserne (base, communes, sauvegardes).\nExportez-les d'abord.\n\nTapez son identifiant pour confirmer : ${slug}`);
        if (typed === null) return;
        await api(`/api/plateforme/casernes/${id}?confirmation=${encodeURIComponent(typed)}`, { method: "DELETE" });
        showToast("Caserne supprimée");
      } else if (act === "compte") {
        await api(`/api/plateforme/casernes/${id}/comptes`, { method: "POST", body: { identifiant: v("a_ident").trim(), nom: v("a_nom").trim(), password: v("a_pwd") } });
        showToast("Compte administrateur créé ✓");
      }
      await refresh();
    } catch (err) { showToast(err.message, true); }
  });

  $("pf-new").addEventListener("click", () => {
    $("pf-create-form").reset();
    $("pf-create-error").hidden = true;
    $("pf-c-hosts-hint").textContent = state.domaine
      ? `Sans adresse, le site sera à <identifiant>.${state.domaine}.` : "Domaine de la plateforme pas encore réglé (PLATFORM_DOMAIN) : indiquez l'adresse complète, ou plus tard.";
    $("pf-create").showModal();
  });
  $("pf-c-nom").addEventListener("input", () => {
    if ($("pf-c-slug").dataset.touched) return;
    const base = $("pf-c-nom").value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/sapeurs?[- ]pompiers?( de| d'|du|des)?/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    $("pf-c-slug").value = base.slice(0, 40);
  });
  $("pf-c-slug").addEventListener("input", () => { $("pf-c-slug").dataset.touched = "1"; });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

  $("pf-create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/plateforme/casernes", { method: "POST", body: {
        nom: $("pf-c-nom").value.trim(), slug: $("pf-c-slug").value.trim(), hosts: lines($("pf-c-hosts").value),
        admin_identifiant: $("pf-c-ident").value.trim(), admin_nom: $("pf-c-anom").value.trim(), admin_password: $("pf-c-pwd").value,
        communes: parseCommunes($("pf-c-communes").value),
      } });
      $("pf-create").close();
      showToast("Caserne créée ✓");
      await refresh();
    } catch (err) {
      $("pf-create-error").textContent = err.message;
      $("pf-create-error").hidden = false;
    }
  });

  $("pf-demandes").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-dem]");
    if (!btn) return;
    try {
      await api(`/api/plateforme/demandes/${btn.closest(".pf-demande").dataset.id}`, { method: "PUT", body: { traitee: btn.dataset.dem === "1" } });
      await refresh();
    } catch (err) { showToast(err.message, true); }
  });

  $("pf-compte-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/plateforme/comptes", { method: "POST", body: { identifiant: $("pf-a-ident").value.trim(), nom: $("pf-a-nom").value.trim(), password: $("pf-a-pwd").value } });
      $("pf-compte-form").reset();
      showToast("Compte créé ✓");
      await refresh();
    } catch (err) { showToast(err.message, true); }
  });
  $("pf-comptes").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-cpt]");
    if (!btn) return;
    const id = btn.closest(".pf-compte").dataset.id;
    try {
      if (btn.dataset.cpt === "pwd") {
        const pwd = prompt("Nouveau mot de passe (10 caractères au moins) :");
        if (!pwd) return;
        await api(`/api/plateforme/comptes/${id}`, { method: "PUT", body: { password: pwd } });
        showToast("Mot de passe changé ✓");
      } else {
        await api(`/api/plateforme/comptes/${id}`, { method: "PUT", body: { actif: btn.dataset.cpt === "on" } });
      }
      await refresh();
    } catch (err) { showToast(err.message, true); }
  });

  $("pf-abos").addEventListener("change", async () => {
    try {
      await api("/api/plateforme/reglages", { method: "PUT", body: { abonnements_actifs: $("pf-abos").checked } });
      await refresh();
    } catch (err) { showToast(err.message, true); }
  });

  $("pf-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await fetchJSON("/api/plateforme/login", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiant: $("pf-ident").value.trim(), password: $("pf-password").value }) });
      $("pf-password").value = "";
      $("pf-login-error").hidden = true;
      await start();
    } catch (err) {
      $("pf-login-error").textContent = err.message;
      $("pf-login-error").hidden = false;
    }
  });
  $("pf-logout").addEventListener("click", async () => {
    await fetchJSON("/api/plateforme/logout", { method: "POST" }).catch(() => {});
    showLogin();
  });

  start();
})();
