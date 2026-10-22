/* Onglet « Comptes & journal » de l'admin : comptes nominatifs de la console, rôles (droits)
   et journal des modifications (qui a fait quoi, quand). */
(() => {
  "use strict";
  const { escapeHtml, fetchJSON, showToast } = window.Common;
  const $ = (id) => document.getElementById(id);

  const ACTIONS = {
    connexion: "Connexion", "connexion.echec": "Connexion refusée",
    statut: "Statut d'une maison", note: "Note", signalement: "Signalement", "signalement.traite": "Signalement traité",
    "don.ajout": "Don enregistré", "don.statut": "Paiement validé / refusé", "don.suppression": "Don supprimé",
    "remise.declaree": "Remise de caisse", "remise.confirmee": "Remise confirmée", "remise.annulee": "Confirmation annulée",
    "remise.suppression": "Remise supprimée",
    avancement: "Avancement du secteur", "equipe.modif": "Équipe modifiée", "equipe.renfort": "Équipier ajouté (terrain)",
    "equipe.retrait": "Équipier retiré (terrain)",
    "personne.ajout": "Personne ajoutée", "personne.modif": "Personne modifiée", "personne.suppression": "Personne supprimée",
    "personne.code": "Nouveau code d'accès", "acces.envoi": "Code envoyé par WhatsApp",
    "secteurs.enregistres": "Secteurs enregistrés", "adresses.exclues": "Adresses exclues", "adresses.reintegrees": "Adresses réintégrées",
    "statuts.remise_a_zero": "Statuts remis à zéro",
    reglages: "Réglages", sauvegarde: "Sauvegarde",
    "compte.ajout": "Compte créé", "compte.modif": "Compte modifié", "compte.suppression": "Compte supprimé",
    "compte.mot_de_passe": "Mot de passe changé",
    "role.ajout": "Rôle créé", "role.modif": "Rôle modifié", "role.suppression": "Rôle supprimé",
  };
  const SOURCE = { console: "admin", terrain: "terrain", "système": "auto" };

  const st = { me: null, data: null, entries: [], filterTimer: null, onUnauthorized: () => {} };

  async function api(url, options) {
    try {
      return await fetchJSON(url, options);
    } catch (err) {
      if (err.status === 401) st.onUnauthorized();
      if (err.status === 422) err.message = "Valeur refusée : vérifiez la saisie (identifiant sans espace, mot de passe de 8 caractères ou plus).";
      throw err;
    }
  }
  const send = (url, method, body) => api(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const can = (p) => !!st.me && st.me.permissions.includes(p);
  const when = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "jamais");

  // ---- comptes ----
  function renderAccounts() {
    const { comptes, roles } = st.data;
    const roleOptions = (sel) => roles.map((r) => `<option value="${r.id}"${r.id === sel ? " selected" : ""}>${escapeHtml(r.nom)}</option>`).join("");
    $("cpt-role").innerHTML = roleOptions(roles.find((r) => !r.fixe)?.id);
    $("cpt-list").innerHTML = `<div class="cpt-row principal"><span class="cpt-who"><b>Administrateur principal</b><small>mot de passe du fichier .env · tous les droits</small></span></div>`
      + (comptes.map((c) => `<div class="cpt-row${c.actif ? "" : " off"}" data-id="${c.id}">
          <span class="cpt-who"><b>${escapeHtml(c.nom)}</b><small>${escapeHtml(c.identifiant)} · dernière connexion : ${when(c.derniere_connexion)}</small></span>
          <select data-f="role" aria-label="Rôle de ${escapeHtml(c.nom)}"${c.id === st.me.id ? " disabled" : ""}>${roleOptions(c.role_id)}</select>
          <span class="cpt-actions">
            <button type="button" class="btn small" data-act="pwd">Mot de passe…</button>
            ${c.id === st.me.id ? `<span class="hint">vous</span>` : `<button type="button" class="btn small" data-act="toggle">${c.actif ? "Désactiver" : "Réactiver"}</button>
            <button type="button" class="icon-btn danger" data-act="delete" title="Supprimer" aria-label="Supprimer le compte de ${escapeHtml(c.nom)}">✕</button>`}
          </span></div>`).join("") || `<p class="hint">Aucun autre compte pour l'instant.</p>`);
  }

  $("cpt-list").addEventListener("change", async (e) => {
    const sel = e.target.closest('[data-f="role"]');
    if (!sel) return;
    const id = Number(sel.closest(".cpt-row").dataset.id);
    try {
      await send(`/api/admin/comptes/${id}`, "PUT", { role_id: Number(sel.value) });
      showToast("Rôle changé ✓");
      await load();
    } catch (err) { showToast(err.message, true); }
  });

  $("cpt-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = Number(btn.closest(".cpt-row").dataset.id);
    const c = st.data.comptes.find((x) => x.id === id);
    try {
      if (btn.dataset.act === "toggle") {
        await send(`/api/admin/comptes/${id}`, "PUT", { actif: !c.actif });
        showToast(c.actif ? `${c.nom} ne peut plus se connecter.` : `${c.nom} peut de nouveau se connecter.`);
      } else if (btn.dataset.act === "delete") {
        if (!confirm(`Supprimer le compte de ${c.nom} ? (Le journal garde ce qu'il a fait.)`)) return;
        await send(`/api/admin/comptes/${id}`, "DELETE");
      } else if (btn.dataset.act === "pwd") {
        const pwd = prompt(`Nouveau mot de passe pour ${c.nom} (8 caractères ou plus) :`, randomPassword());
        if (!pwd) return;
        await send(`/api/admin/comptes/${id}`, "PUT", { password: pwd });
        showToast(`Mot de passe de ${c.nom} changé : transmettez-le-lui.`);
      }
      await load();
    } catch (err) { showToast(err.message, true); }
  });

  function randomPassword() {
    const a = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, (b) => a[b % a.length]).join("");
  }
  $("cpt-gen").addEventListener("click", () => { $("cpt-pwd").value = randomPassword(); });

  $("cpt-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const c = await send("/api/admin/comptes", "POST", {
        nom: $("cpt-nom").value, identifiant: $("cpt-ident").value.trim(), role_id: Number($("cpt-role").value), password: $("cpt-pwd").value,
      });
      showToast(`Compte créé pour ${c.nom} : identifiant « ${c.identifiant} ». Transmettez-lui son mot de passe.`);
      $("cpt-form").reset();
      await load();
    } catch (err) { showToast(err.message, true); }
  });

  // ---- rôles ----
  function renderRoles() {
    const { roles, permissions, comptes } = st.data;
    $("role-list").innerHTML = roles.map((r) => {
      const used = comptes.filter((c) => c.role_id === r.id).length;
      return `<div class="role-card${r.fixe ? " fixed" : ""}" data-id="${r.id}">
        <div class="role-head"><b>${escapeHtml(r.nom)}</b><small class="hint">${used} compte${used > 1 ? "s" : ""}</small>
          ${r.fixe ? `<small class="hint">tous les droits</small>` : `<button type="button" class="link-btn" data-act="rename">Renommer</button>
          <button type="button" class="icon-btn danger" data-act="delete" title="Supprimer le rôle" aria-label="Supprimer le rôle ${escapeHtml(r.nom)}">✕</button>`}</div>
        <div class="role-perms">${Object.entries(permissions).map(([k, label]) => `<label title="${escapeHtml(label)}">
          <input type="checkbox" data-perm="${k}" ${r.permissions.includes(k) ? "checked" : ""} ${r.fixe ? "disabled" : ""} />
          <span><b>${escapeHtml(label.split(" : ")[0])}</b> <small>${escapeHtml(label.split(" : ")[1] || "")}</small></span></label>`).join("")}</div>
      </div>`;
    }).join("");
  }

  $("role-list").addEventListener("change", async (e) => {
    const box = e.target.closest("[data-perm]");
    if (!box) return;
    const card = box.closest(".role-card");
    const role = st.data.roles.find((r) => r.id === Number(card.dataset.id));
    const perms = [...card.querySelectorAll("[data-perm]:checked")].map((x) => x.dataset.perm);
    try {
      await send(`/api/admin/roles/${role.id}`, "PUT", { nom: role.nom, permissions: perms });
      showToast(`Rôle « ${role.nom} » enregistré ✓`);
      await load();
    } catch (err) { showToast(err.message, true); await load(); }
  });

  $("role-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const role = st.data.roles.find((r) => r.id === Number(btn.closest(".role-card").dataset.id));
    try {
      if (btn.dataset.act === "rename") {
        const nom = prompt("Nouveau nom du rôle :", role.nom);
        if (!nom || nom.trim() === role.nom) return;
        await send(`/api/admin/roles/${role.id}`, "PUT", { nom, permissions: role.permissions });
      } else {
        if (!confirm(`Supprimer le rôle « ${role.nom} » ?`)) return;
        await send(`/api/admin/roles/${role.id}`, "DELETE");
      }
      await load();
    } catch (err) { showToast(err.message, true); }
  });

  $("role-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await send("/api/admin/roles", "POST", { nom: $("role-nom").value, permissions: [] });
      $("role-nom").value = "";
      showToast("Rôle créé : cochez ses droits.");
      await load();
    } catch (err) { showToast(err.message, true); }
  });

  // ---- journal ----
  function journalQuery(before) {
    const p = new URLSearchParams({ q: $("jr-q").value, action: $("jr-action").value, qui: $("jr-qui").value, limit: "200" });
    if (before) p.set("before", before);
    return `/api/admin/journal?${p}`;
  }

  function row(x) {
    const label = ACTIONS[x.action] || x.action;
    const cls = /suppression|echec|retrait|annulee|remise_a_zero/.test(x.action) ? " warn" : "";
    return `<tr class="${cls}"><td>${when(x.at)}</td>
      <td>${escapeHtml(x.qui)} <small class="src src-${escapeHtml(x.source)}">${SOURCE[x.source] || escapeHtml(x.source)}</small></td>
      <td>${escapeHtml(label)}</td><td>${escapeHtml(x.objet)}</td><td>${escapeHtml(x.details)}</td></tr>`;
  }

  async function loadJournal(more) {
    const before = more && st.entries.length ? st.entries[st.entries.length - 1].id : null;
    const r = await api(journalQuery(before));
    st.entries = more ? [...st.entries, ...r.entrees] : r.entrees;
    $("jr-body").innerHTML = st.entries.map(row).join("") || `<tr><td colspan="5" class="hint">Rien pour l'instant.</td></tr>`;
    $("jr-more").hidden = r.entrees.length < 200;
    const cur = $("jr-qui").value;
    $("jr-qui").innerHTML = `<option value="">Tout le monde</option>${r.personnes.map((n) => `<option${n === cur ? " selected" : ""}>${escapeHtml(n)}</option>`).join("")}`;
  }

  const refilter = () => { clearTimeout(st.filterTimer); st.filterTimer = setTimeout(() => loadJournal(false).catch((err) => showToast(err.message, true)), 250); };
  $("jr-q").addEventListener("input", refilter);
  $("jr-action").addEventListener("change", refilter);
  $("jr-qui").addEventListener("change", refilter);
  $("jr-more").addEventListener("click", () => loadJournal(true).catch((err) => showToast(err.message, true)));

  $("jr-export").addEventListener("click", async () => {
    try {
      const r = await api(journalQuery(null).replace("limit=200", "limit=5000"));
      const cell = (v) => `"${String(v ?? "").replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;
      const rows = [["Date", "Qui", "Depuis", "Action", "Sur", "Détail"],
        ...r.entrees.map((x) => [new Date(x.at).toLocaleString("fr-FR"), x.qui, SOURCE[x.source] || x.source, ACTIONS[x.action] || x.action, x.objet, x.details])];
      const csv = "﻿" + rows.map((l) => l.map(cell).join(";")).join("\r\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      a.download = "journal-des-modifications.csv";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (err) { showToast(err.message, true); }
  });

  // ---- mon compte ----
  const meDialog = $("me-dialog");
  function openMe() {
    $("me-info").textContent = st.me.principal
      ? "Compte principal : son mot de passe est ADMIN_PASSWORD dans le fichier .env du serveur."
      : `${st.me.nom} · identifiant « ${st.me.identifiant} » · rôle ${st.me.role}`;
    $("me-pwd").hidden = st.me.principal;
    $("me-save").hidden = st.me.principal;
    $("me-old").value = "";
    $("me-new").value = "";
    $("me-error").hidden = true;
    meDialog.showModal();
  }
  meDialog.querySelector("[data-close]").addEventListener("click", () => meDialog.close());
  $("me-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await send("/api/admin/mot-de-passe", "POST", { actuel: $("me-old").value, nouveau: $("me-new").value });
      meDialog.close();
      showToast("Mot de passe changé ✓ (vos autres sessions sont déconnectées)");
    } catch (err) {
      $("me-error").textContent = err.status === 422 ? "Le nouveau mot de passe doit faire au moins 8 caractères." : err.message;
      $("me-error").hidden = false;
    }
  });

  async function load() {
    st.data = await api("/api/admin/comptes");
    renderAccounts();
    renderRoles();
  }

  window.Comptes = {
    setMe(me) {
      st.me = me;
      const btn = $("btn-me");
      btn.textContent = `${me.nom} · ${me.role}`;
      btn.hidden = false;
      btn.onclick = openMe;
    },
    async open({ onUnauthorized } = {}) {
      if (onUnauthorized) st.onUnauthorized = onUnauthorized;
      $("cpt-accounts").hidden = !can("comptes");
      $("cpt-roles").hidden = !can("comptes");
      $("cpt-journal").hidden = !can("journal") && !can("comptes");
      if (can("comptes")) await load();
      if (can("journal") || can("comptes")) await loadJournal(false);
    },
  };
})();
