/* Admin central d'Almaneo : tableau de bord, casernes, demandes de démo, réglages, comptes, journal. */
(() => {
  "use strict";
  const { escapeHtml, fetchJSON, showToast, euros } = window.Common;
  const $ = (id) => document.getElementById(id);
  const STATUT = { active: "Active", suspendue: "Suspendue", archivee: "Archivée" };
  const FORMULE = { gratuit: "Gratuit", essai: "Essai", actif: "Abonnement actif", expire: "Expiré" };
  const state = { casernes: [], abos: false, domaine: "", moi: null, demandes: [], managed: null };

  const api = async (url, opts = {}) => {
    try {
      return await fetchJSON(url, opts.body ? { ...opts, headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body) } : opts);
    } catch (err) {
      if (err.status === 401) showLogin();
      throw err;
    }
  };
  const lines = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);
  const dateFr = (iso) => new Date(iso).toLocaleDateString("fr-FR");
  const initials = (nom) => nom.replace(/sapeurs?[- ]pompiers?( de| d'| du| des)?/i, "").trim().split(/[\s-]+/).filter(Boolean)
    .slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";

  function showLogin() {
    $("pf-login").hidden = false;
    $("pf-app").hidden = true;
    $("pf-nav").hidden = true;
    $("pf-logout").hidden = true;
    $("pf-me").hidden = true;
  }

  async function start() {
    try {
      const me = await fetchJSON("/api/plateforme/moi");
      state.domaine = me.domaine;
      state.moi = me.moi;
    } catch { showLogin(); return; }
    $("pf-me").textContent = state.moi.nom;
    $("pf-hello-title").textContent = `Bonjour ${state.moi.nom.split(" ")[0]} 👋`;
    for (const id of ["pf-me", "pf-logout"]) $(id).hidden = false;
    $("pf-nav").hidden = false;
    $("pf-login").hidden = true;
    $("pf-app").hidden = false;
    await refresh();
  }

  async function refresh() {
    const [r, reg, dm, cp, j, tf] = await Promise.all([api("/api/plateforme/casernes"), api("/api/plateforme/reglages"),
      api("/api/plateforme/demandes"), api("/api/plateforme/comptes"), api("/api/plateforme/journal"), api("/api/plateforme/tarifs")]);
    if (!state.tarifsDirty) renderTarifs(tf);
    state.casernes = r.casernes;
    state.abos = r.abonnements_actifs;
    state.demandes = dm.demandes;
    renderKpis();
    renderCasernes();
    renderDemandes();
    renderSettings(reg);
    renderComptes(cp.comptes);
    $("pf-journal").innerHTML = j.entrees.length ? j.entrees.slice(0, 60).map((e) => `<div class="pf-jr">
        <time>${new Date(e.at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</time>
        <span><b>${escapeHtml(e.action)}</b> ${escapeHtml(e.objet)} <small class="hint">${escapeHtml(e.details)}</small></span>
        <small class="pf-qui">— ${escapeHtml(e.qui)}</small></div>`).join("")
      : `<p class="hint">Rien pour l'instant.</p>`;
    if (state.managed) fillManage();
    // un téléchargement de communes en cours : on revient voir dans un moment
    if (state.casernes.some((c) => c.generation && c.generation.statut === "en_cours")) setTimeout(() => refresh().catch(() => {}), 8000);
  }

  function renderKpis() {
    const actives = state.casernes.filter((c) => c.statut === "active");
    const total = state.casernes.reduce((n, c) => n + (c.stats.total || 0), 0);
    const personnes = state.casernes.reduce((n, c) => n + c.stats.personnes, 0);
    const nouvelles = state.demandes.filter((d) => !d.traitee).length;
    const tile = (label, value, sub, cls = "") => `<div class="pf-kpi ${cls}"><span>${label}</span><strong>${value}</strong><small>${sub}</small></div>`;
    $("pf-kpis").innerHTML = [
      tile("Casernes actives", actives.length, `${state.casernes.length} au total`),
      tile("Équipiers", personnes, "dans toutes les casernes"),
      tile("Dons de l'année", euros(total), "toutes casernes confondues", "money"),
      tile("Demandes de démo", nouvelles, nouvelles ? "à traiter" : "rien en attente", nouvelles ? "alert" : ""),
    ].join("");
    const n = state.casernes.length;
    $("pf-summary").textContent = n ? `${n} caserne${n > 1 ? "s" : ""} · ${actives.length} active(s)` : "Aucune caserne pour l'instant.";
    $("pf-nav-dem").hidden = !nouvelles;
  }

  function genLine(g) {
    if (!g) return `<span class="pf-warn">Communes pas encore téléchargées</span>`;
    const noms = g.communes.map((c) => c.nom).join(", ");
    if (g.statut === "en_cours") return `<span class="pf-run">⏳ Téléchargement en cours : ${escapeHtml(noms)}</span>`;
    if (g.statut === "echec") return `<span class="pf-ko">✕ Échec du téléchargement (${escapeHtml(noms)})</span>`;
    return `<span class="pf-ok">✓ Communes prêtes : ${escapeHtml(noms)}</span>`;
  }

  function renderCasernes() {
    $("pf-list").innerHTML = state.casernes.length ? state.casernes.map((c) => {
      const s = c.stats;
      const abo = c.abonnement;
      return `<article class="pf-caserne st-${c.statut}" data-id="${c.id}">
        <div class="pf-c-head">
          <span class="pf-avatar" aria-hidden="true">${escapeHtml(initials(c.nom))}</span>
          <div class="pf-c-title"><h3>${escapeHtml(c.nom)}</h3>
            ${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.url.replace(/^https:\/\//, "").replace(/\/$/, ""))}</a>` : `<span class="hint">aucune adresse</span>`}</div>
          <span class="pf-badge st-${c.statut}">${STATUT[c.statut]}</span>
        </div>
        <p class="pf-gen">${genLine(c.generation)}</p>
        <div class="pf-chips">
          <span title="Personnes (équipiers)">👥 ${s.personnes}</span>
          <span title="Secteurs">🗺️ ${s.secteurs} secteur${s.secteurs > 1 ? "s" : ""}</span>
          <span title="Dons ${s.annee}">💶 ${euros(s.total)}</span>
          <span title="Dernière sauvegarde" class="${s.derniere_sauvegarde ? "" : "warn"}">💾 ${s.derniere_sauvegarde ? dateFr(s.derniere_sauvegarde) : "pas encore"}</span>
          <span title="Envoi des accès par le bot WhatsApp" class="${c.whatsapp.actif ? "on" : ""}">📲 ${c.whatsapp.actif ? "Bot WhatsApp" : "Sans bot"}</span>
          ${state.abos ? `<span class="${abo.actif ? "" : "warn"}">🧾 ${FORMULE[c.abonnement_formule]}${abo.actif ? "" : " — expiré"}</span>` : ""}
        </div>
        <div class="pf-c-actions">
          ${c.url ? `<a class="btn small" href="${escapeHtml(c.url)}admin" target="_blank" rel="noopener">Ouvrir ↗</a>` : ""}
          <button type="button" class="btn small primary" data-act="gerer">Gérer</button>
        </div>
      </article>`;
    }).join("") : `<div class="pf-empty"><p>Aucune caserne pour l'instant.</p><button type="button" class="btn primary" data-act="nouvelle">+ Créer la première caserne</button></div>`;
  }

  // ---- fenêtre « Gérer » ----
  function fillManage() {
    const c = state.casernes.find((x) => x.id === state.managed);
    if (!c) { $("pf-manage").close(); return; }
    $("pf-m-title").textContent = c.nom;
    $("pf-m-sub").innerHTML = `${escapeHtml(c.slug)} · <span class="pf-badge st-${c.statut}">${STATUT[c.statut]}</span> · ${genLine(c.generation)}`;
    $("pf-m-body").innerHTML = `
      <section class="pf-block"><h3>Nom et adresses</h3>
        <label class="pf-field">Nom<input data-f="nom" value="${escapeHtml(c.nom)}" maxlength="120" /></label>
        <label class="pf-field">Adresse(s) propre(s) au site (une par ligne)<textarea data-f="hosts" rows="2" spellcheck="false">${escapeHtml(c.hosts.join("\n"))}</textarea></label>
        <p class="hint">${state.domaine ? `Toujours joignable aussi sur ${escapeHtml(c.slug)}.${escapeHtml(state.domaine)}.` : ""}</p>
        <div class="pf-actions"><button type="button" class="btn small primary" data-act="save">Enregistrer</button></div>
      </section>
      <section class="pf-block"><h3>Bot WhatsApp</h3>
        <label class="setting-row"><input type="checkbox" data-f="whatsapp_actif"${c.whatsapp.actif ? " checked" : ""} />
          <span>Envoi des codes d'accès par le bot WhatsApp${state.botUrl ? "" : " <small class=\"pf-warn\">(bot de la plateforme pas encore réglé)</small>"}</span></label>
        <details class="pf-more"${c.whatsapp.url ? " open" : ""}><summary>Bot propre à cette caserne (facultatif)</summary>
          <div class="pf-row">
            <label class="pf-field">Adresse<input data-f="whatsapp_url" value="${escapeHtml(c.whatsapp.url)}" maxlength="300" placeholder="vide = bot de la plateforme" spellcheck="false" /></label>
            <label class="pf-field">Clé<input data-f="whatsapp_key" type="password" maxlength="200" autocomplete="new-password" placeholder="${c.whatsapp.key_set ? "réglée (vide = la garder)" : "aucune"}" /></label>
          </div></details>
        <div class="pf-actions"><button type="button" class="btn small primary" data-act="bot">Enregistrer</button></div>
      </section>
      ${state.abos ? `<section class="pf-block"><h3>Abonnement</h3>
        <div class="pf-row">
          <label class="pf-field">Formule<select data-f="abonnement">${Object.entries(FORMULE).map(([k, v]) => `<option value="${k}"${k === c.abonnement_formule ? " selected" : ""}>${v}</option>`).join("")}</select></label>
          <label class="pf-field">Fin<input type="date" data-f="abonnement_fin" value="${escapeHtml(c.abonnement_fin || "")}" /></label>
        </div>
        <div class="pf-actions"><button type="button" class="btn small primary" data-act="abonnement">Enregistrer</button></div></section>` : ""}
      <section class="pf-block"><h3>Communes</h3>
        <p class="hint">${c.stats.communes.length ? `Actuellement : ${c.stats.communes.map(escapeHtml).join(", ")}.` : "Aucune commune."} ${c.generation && c.generation.statut === "echec" ? `<details><summary>détails de l'échec</summary><pre>${escapeHtml(c.generation.message)}</pre></details>` : ""}</p>
        <label class="pf-field">Communes à télécharger (une par ligne : Nom, code postal)<textarea data-f="communes" rows="2" placeholder="Vaugneray, 69670"></textarea></label>
        <div class="pf-actions"><button type="button" class="btn small" data-act="communes">Télécharger les communes</button></div>
      </section>
      <section class="pf-block"><h3>Compte administrateur de secours</h3>
        <p class="hint">Par exemple si le responsable de la caserne a perdu son mot de passe.</p>
        <div class="pf-row">
          <label class="pf-field">Identifiant<input data-f="a_ident" maxlength="60" autocapitalize="none" /></label>
          <label class="pf-field">Nom<input data-f="a_nom" maxlength="80" /></label>
          <label class="pf-field">Mot de passe provisoire<input data-f="a_pwd" minlength="8" maxlength="200" autocomplete="new-password" /></label>
        </div>
        <div class="pf-actions"><button type="button" class="btn small" data-act="compte">Créer le compte</button></div>
      </section>
      <section class="pf-block danger-zone"><h3>Données et statut</h3>
        <div class="pf-actions">
          <a class="btn small" href="/api/plateforme/casernes/${c.id}/export" download>⬇ Exporter toutes les données</a>
          ${c.statut === "active" ? `<button type="button" class="btn small" data-act="suspendue">Suspendre</button>` : `<button type="button" class="btn small" data-act="active">Réactiver</button>`}
          ${c.statut !== "archivee" ? `<button type="button" class="btn small danger" data-act="archivee">Archiver</button>` : ""}
          ${c.statut === "archivee" ? `<button type="button" class="btn small danger" data-act="supprimer">Supprimer définitivement</button>` : ""}
        </div>
        <p class="hint">Suspendre : le site de la caserne ne répond plus (données gardées). Archiver : fermé et plus de sauvegardes. Supprimer : seulement une caserne archivée, après export.</p>
      </section>`;
  }

  function openManage(id) {
    state.managed = id;
    fillManage();
    if (!$("pf-manage").open) $("pf-manage").showModal();
  }

  function parseCommunes(text) {
    return lines(text).map((l) => {
      const m = l.match(/^(.+?)[,;\s]+(\d{5})$/);
      if (!m) throw new Error(`Commune illisible : « ${l} » (attendu : Nom, code postal)`);
      return { nom: m[1].trim(), code_postal: m[2] };
    });
  }

  $("pf-m-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = state.managed;
    const box = $("pf-m-body");
    const v = (f) => { const el = box.querySelector(`[data-f="${f}"]`); return el ? (el.type === "checkbox" ? el.checked : el.value) : ""; };
    const act = btn.dataset.act;
    try {
      if (act === "save") {
        await api(`/api/plateforme/casernes/${id}`, { method: "PUT", body: { nom: v("nom").trim(), hosts: lines(v("hosts")) } });
        showToast("Enregistré ✓");
      } else if (act === "bot") {
        const body = { whatsapp_actif: v("whatsapp_actif"), whatsapp_url: v("whatsapp_url").trim() };
        if (v("whatsapp_key")) body.whatsapp_key = v("whatsapp_key");
        await api(`/api/plateforme/casernes/${id}`, { method: "PUT", body });
        showToast("Bot WhatsApp enregistré ✓");
      } else if (act === "abonnement") {
        await api(`/api/plateforme/casernes/${id}`, { method: "PUT", body: { abonnement: v("abonnement"), abonnement_fin: v("abonnement_fin") } });
        showToast("Abonnement enregistré ✓");
      } else if (["active", "suspendue", "archivee"].includes(act)) {
        const msg = { suspendue: "Suspendre cette caserne ? Son site et son appli ne répondront plus (données gardées).",
          archivee: "Archiver cette caserne ? Son site est fermé et ses sauvegardes automatiques s'arrêtent (données gardées).", active: "" }[act];
        if (msg && !confirm(msg)) return;
        await api(`/api/plateforme/casernes/${id}`, { method: "PUT", body: { statut: act } });
        showToast(`Caserne ${STATUT[act].toLowerCase()} ✓`);
      } else if (act === "supprimer") {
        const { slug } = state.casernes.find((x) => x.id === id);
        const typed = prompt(`Suppression DÉFINITIVE de toutes les données de cette caserne (base, communes, sauvegardes).\nExportez-les d'abord.\n\nTapez son identifiant pour confirmer : ${slug}`);
        if (typed === null) return;
        await api(`/api/plateforme/casernes/${id}?confirmation=${encodeURIComponent(typed)}`, { method: "DELETE" });
        state.managed = null;
        $("pf-manage").close();
        showToast("Caserne supprimée");
      } else if (act === "communes") {
        await api(`/api/plateforme/casernes/${id}/communes`, { method: "POST", body: { communes: parseCommunes(v("communes")) } });
        showToast("Téléchargement lancé : quelques minutes…");
      } else if (act === "compte") {
        await api(`/api/plateforme/casernes/${id}/comptes`, { method: "POST", body: { identifiant: v("a_ident").trim(), nom: v("a_nom").trim(), password: v("a_pwd") } });
        showToast("Compte administrateur créé ✓");
      }
      await refresh();
    } catch (err) { showToast(err.message, true); }
  });

  $("pf-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "nouvelle") { openCreate(); return; }
    openManage(Number(btn.closest(".pf-caserne").dataset.id));
  });
  $("pf-manage").addEventListener("close", () => { state.managed = null; });

  // ---- demandes de démo ----
  function renderDemandes() {
    const dm = state.demandes;
    const open = dm.filter((d) => !d.traitee).length;
    $("pf-dem-count").hidden = !open;
    $("pf-dem-count").textContent = `${open} nouvelle${open > 1 ? "s" : ""}`;
    $("pf-demandes").innerHTML = dm.length ? dm.map((d) => `<div class="pf-demande${d.traitee ? " off" : ""}" data-id="${d.id}">
        <div><b>${escapeHtml(d.caserne)}</b> — ${escapeHtml(d.nom)}
          <small class="hint">${new Date(d.created_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</small><br>
          <a href="mailto:${encodeURIComponent(d.email).replace(/%40/g, "@")}">${escapeHtml(d.email)}</a>${d.telephone ? ` · ${escapeHtml(d.telephone)}` : ""}
          ${d.commune || d.equipiers || d.offre ? `<br><small>${[d.offre && `🧾 Formule : <b>${escapeHtml(d.offre)}</b>`, d.commune && `📍 ${escapeHtml(d.commune)}`, d.equipiers && `👥 ${escapeHtml(d.equipiers)} équipiers`].filter(Boolean).join(" · ")}</small>` : ""}
          ${d.message ? `<p class="pf-dem-msg">${escapeHtml(d.message)}</p>` : ""}</div>
        <button type="button" class="btn small" data-dem="${d.traitee ? "0" : "1"}">${d.traitee ? "Rouvrir" : "✓ Traitée"}</button></div>`).join("")
      : `<p class="hint">Aucune demande pour l'instant.</p>`;
  }
  $("pf-demandes").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-dem]");
    if (!btn) return;
    try {
      await api(`/api/plateforme/demandes/${btn.closest(".pf-demande").dataset.id}`, { method: "PUT", body: { traitee: btn.dataset.dem === "1" } });
      await refresh();
    } catch (err) { showToast(err.message, true); }
  });

  // ---- réglages : bot WhatsApp et abonnements ----
  function renderSettings(reg) {
    state.botUrl = reg.whatsapp_bot_url;
    if (document.activeElement !== $("pf-bot-url")) $("pf-bot-url").value = reg.whatsapp_bot_url;
    $("pf-bot-key").placeholder = reg.whatsapp_bot_key_set ? "réglée (vide = la garder)" : "aucune";
    $("pf-abos").checked = reg.abonnements_actifs;
  }
  $("pf-bot-save").addEventListener("click", async () => {
    try {
      const body = { whatsapp_bot_url: $("pf-bot-url").value.trim() };
      if ($("pf-bot-key").value) body.whatsapp_bot_key = $("pf-bot-key").value;
      await api("/api/plateforme/reglages", { method: "PUT", body });
      $("pf-bot-key").value = "";
      showToast("Bot WhatsApp enregistré ✓");
      await refresh();
    } catch (err) { showToast(err.message, true); }
  });
  $("pf-bot-test").addEventListener("click", async () => {
    const el = $("pf-bot-state");
    el.className = "pf-bot-state";
    el.textContent = "…";
    try {
      const r = await api("/api/plateforme/whatsapp/test", { method: "POST" });
      el.classList.add(r.ok ? "ok" : "ko");
      el.textContent = `● ${r.message}`;
    } catch (err) { el.classList.add("ko"); el.textContent = `● ${err.message}`; }
  });
  $("pf-abos").addEventListener("change", async () => {
    try {
      await api("/api/plateforme/reglages", { method: "PUT", body: { abonnements_actifs: $("pf-abos").checked } });
      await refresh();
    } catch (err) { showToast(err.message, true); }
  });

  // ---- tarifs du site vitrine ----
  function offreHtml(o, i) {
    return `<div class="pf-offre" data-i="${i}">
      <div class="pf-row"><label class="pf-field">Nom<input data-o="nom" maxlength="40" value="${escapeHtml(o.nom || "")}" placeholder="Amicale" /></label>
        <label class="pf-field">Prix<input data-o="prix" maxlength="30" value="${escapeHtml(o.prix || "")}" placeholder="149 €" /></label>
        <label class="pf-field">Période<input data-o="periode" maxlength="30" value="${escapeHtml(o.periode || "")}" placeholder="par an" /></label></div>
      <label class="pf-field">Phrase d'accroche<input data-o="accroche" maxlength="160" value="${escapeHtml(o.accroche || "")}" /></label>
      <label class="pf-field">Ce qui est inclus (une ligne par point)<textarea data-o="inclus" rows="4">${escapeHtml((o.inclus || []).join("\n"))}</textarea></label>
      <div class="pf-row"><label class="pf-field">Texte du bouton<input data-o="bouton" maxlength="40" value="${escapeHtml(o.bouton || "")}" placeholder="Choisir cette formule" /></label>
        <label class="setting-row pf-offre-vedette"><input type="checkbox" data-o="vedette"${o.vedette ? " checked" : ""} /><span>Mise en avant (« Recommandé »)</span></label></div>
      <div class="pf-actions"><button type="button" class="btn small" data-offre-move="-1"${i === 0 ? " disabled" : ""}>↑</button>
        <button type="button" class="btn small" data-offre-move="1">↓</button>
        <button type="button" class="btn small danger" data-offre-del>Supprimer</button></div></div>`;
  }
  function readTarifs() {
    return {
      actif: $("pf-tarifs-actif").checked,
      note: $("pf-tarifs-note").value,
      offres: [...document.querySelectorAll(".pf-offre")].map((el) => {
        const f = (k) => el.querySelector(`[data-o="${k}"]`);
        return { nom: f("nom").value.trim(), prix: f("prix").value, periode: f("periode").value, accroche: f("accroche").value,
          inclus: f("inclus").value.split("\n").map((x) => x.trim()).filter(Boolean), bouton: f("bouton").value, vedette: f("vedette").checked };
      }),
    };
  }
  function renderTarifs(t) {
    $("pf-tarifs-actif").checked = !!t.actif;
    $("pf-tarifs-note").value = t.note || "";
    $("pf-offres").innerHTML = (t.offres || []).map(offreHtml).join("");
    $("pf-offre-add").disabled = (t.offres || []).length >= 4;
    $("pf-tarifs-voir").href = state.domaine ? `https://${state.domaine}/#tarifs` : "/";
  }
  $("tarifs").addEventListener("input", () => { state.tarifsDirty = true; });
  $("pf-offre-add").addEventListener("click", () => {
    const t = readTarifs();
    t.offres.push({ nom: "", prix: "", periode: "par an", accroche: "", inclus: [], bouton: "", vedette: false });
    state.tarifsDirty = true;
    renderTarifs(t);
  });
  $("pf-offres").addEventListener("click", (e) => {
    const card = e.target.closest(".pf-offre");
    if (!card) return;
    const i = Number(card.dataset.i);
    const t = readTarifs();
    if (e.target.closest("[data-offre-del]")) t.offres.splice(i, 1);
    else if (e.target.closest("[data-offre-move]")) {
      const j = i + Number(e.target.closest("[data-offre-move]").dataset.offreMove);
      if (j < 0 || j >= t.offres.length) return;
      [t.offres[i], t.offres[j]] = [t.offres[j], t.offres[i]];
    } else return;
    state.tarifsDirty = true;
    renderTarifs(t);
  });
  $("pf-tarifs-save").addEventListener("click", async () => {
    try {
      const t = readTarifs();
      if (t.offres.some((o) => !o.nom)) throw new Error("Chaque formule doit avoir un nom");
      const saved = await api("/api/plateforme/tarifs", { method: "PUT", body: t });
      state.tarifsDirty = false;
      renderTarifs(saved);
      showToast(saved.actif ? "Tarifs enregistrés et affichés sur le site ✓" : "Tarifs enregistrés (cachés sur le site) ✓");
      await refresh();
    } catch (err) { showToast(err.message, true); }
  });

  // ---- comptes de l'admin central ----
  function renderComptes(comptes) {
    $("pf-comptes").innerHTML = comptes.length ? comptes.map((a) => `<div class="pf-compte${a.actif ? "" : " off"}" data-id="${a.id}">
        <span class="pf-avatar small" aria-hidden="true">${escapeHtml(initials(a.nom))}</span>
        <span class="pf-compte-nom"><b>${escapeHtml(a.nom)}</b> <small class="hint">${escapeHtml(a.identifiant)}${a.actif ? "" : " · désactivé"}</small></span>
        <span class="pf-compte-act"><button type="button" class="btn small" data-cpt="pwd">Mot de passe</button>
        ${state.moi && state.moi.id === a.id ? "" : `<button type="button" class="btn small" data-cpt="${a.actif ? "off" : "on"}">${a.actif ? "Désactiver" : "Réactiver"}</button>`}</span></div>`).join("")
      : `<p class="hint">Aucun compte nominatif : seul le compte principal existe.</p>`;
  }
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

  // ---- nouvelle caserne ----
  function openCreate() {
    $("pf-create-form").reset();
    delete $("pf-c-slug").dataset.touched;
    $("pf-create-error").hidden = true;
    $("pf-c-hosts-hint").textContent = state.domaine ? `Le site sera à l'adresse <identifiant>.${state.domaine}.` : "";
    $("pf-create").showModal();
    $("pf-c-nom").focus();
  }
  $("pf-new").addEventListener("click", openCreate);
  $("pf-c-nom").addEventListener("input", () => {
    if ($("pf-c-slug").dataset.touched) return;
    const base = $("pf-c-nom").value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/sapeurs?[- ]pompiers?( de| d'|du|des)?/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    $("pf-c-slug").value = base.slice(0, 40);
    $("pf-c-hosts-hint").textContent = state.domaine && base ? `Le site sera à l'adresse ${base}.${state.domaine}.` : "";
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

  // ---- connexion ----
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
