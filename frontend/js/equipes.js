/* Écran « Équipes » de l'admin : les personnes de la caserne et qui fait quel secteur
   (responsable(s) puis équipiers), avec date, créneau, avancement et consignes.
   Chaque modification est enregistrée aussitôt. */
(() => {
  "use strict";
  const { escapeHtml, fetchJSON, showToast, sectorCode, hameauxPreview } = window.Common;
  const $ = (id) => document.getElementById(id);

  const STATUTS = window.Common.STATUT_LABEL;
  const CRENEAUX = ["Journée", "Matin", "Après-midi", "Soir"];
  const ROLE_LABEL = { responsable: "Responsable", equipier: "Équipiers" };
  const DRAG_TYPE = "application/x-personne";

  const state = {
    loaded: false,
    personnes: [], // [{id, nom, telephone}]
    sectors: [], // [{id, code, nom, couleur, commune, nbAdresses, hameaux}]
    equipes: {}, // sector_id -> {date, creneau, statut, note, membres: [{personne_id, role}]}
    timers: new Map(),
    editing: null, // personne en cours de modification
    onUnauthorized: () => {},
  };

  const els = {
    view: $("teams-view"),
    title: $("teams-title"),
    summary: $("teams-summary"),
    saved: $("teams-saved"),
    alerts: $("teams-alerts"),
    cards: $("team-cards"),
    list: $("people-list"),
    count: $("people-count"),
    form: $("person-form"),
    name: $("person-name"),
    tel: $("person-tel"),
    bulk: $("bulk-names"),
    bulkAdd: $("bulk-add"),
    filter: $("people-filter"),
    free: $("people-free"),
    exportBtn: $("teams-export"),
    pubTeams: $("equipes-public"),
    pubTels: $("telephones-public"),
  };

  // ---- Petits utilitaires -------------------------------------------------------------

  const person = (id) => state.personnes.find((p) => p.id === id);
  const sectorOf = (id) => state.sectors.find((s) => s.id === id);

  function team(sectorId) {
    if (!state.equipes[sectorId]) {
      state.equipes[sectorId] = { date: "", creneau: "", statut: "a_faire", note: "", membres: [] };
    }
    return state.equipes[sectorId];
  }

  /** Secteurs (et rôle) d'une personne. */
  function assignmentsOf(personneId) {
    const out = [];
    for (const s of state.sectors) {
      const m = team(s.id).membres.find((x) => x.personne_id === personneId);
      if (m) out.push({ sector: s, role: m.role });
    }
    return out;
  }

  const avatar = window.Common.personAvatar;
  const telHref = window.Common.telHref;
  const formatDate = (iso) => window.Common.formatDay(iso);

  async function api(url, options) {
    try {
      return await fetchJSON(url, options);
    } catch (err) {
      if (err.status === 401) state.onUnauthorized();
      if (err.status === 422) err.message = "Valeur refusée : vérifiez la saisie.";
      throw err;
    }
  }

  const jsonBody = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  function flashSaved() {
    els.saved.hidden = false;
    els.saved.classList.remove("pop");
    void els.saved.offsetWidth; // relance l'animation
    els.saved.classList.add("pop");
    clearTimeout(flashSaved.t);
    flashSaved.t = setTimeout(() => { els.saved.hidden = true; }, 1800);
  }

  // ---- Chargement ------------------------------------------------------------------------

  async function load() {
    const index = await fetchJSON("/api/communes");
    const [teams, settings, ...communes] = await Promise.all([
      api("/api/admin/equipes"),
      api("/api/admin/settings"),
      ...index.communes.map((c) => fetchJSON(`/api/communes/${encodeURIComponent(c.slug)}`)),
    ]);
    state.personnes = teams.personnes;
    state.equipes = {};
    for (const [id, t] of Object.entries(teams.equipes)) state.equipes[Number(id)] = t;
    state.sectors = communes.flatMap((d) => d.sectors.map((s, i) => ({
      id: s.id,
      code: sectorCode(d.commune.nom, i),
      nom: s.nom,
      couleur: s.couleur,
      commune: d.commune.nom,
      nbAdresses: s.addresses.length,
      hameaux: hameauxPreview(s.resume, 3),
    })));
    state.annee = index.annee;
    els.title.textContent = `Équipes de la ${window.Common.tourneeTitle(index.annee).replace(/^Tournée/, "tournée")}`;
    els.pubTeams.checked = settings.equipes_public;
    els.pubTels.checked = settings.telephones_public;
    els.pubTels.disabled = !settings.equipes_public;
    state.loaded = true;
    render();
  }

  // ---- Enregistrement (équipe d'un secteur, avec un court délai pour grouper les saisies) ----

  function saveTeam(sectorId, delay = 350) {
    clearTimeout(state.timers.get(sectorId));
    state.timers.set(sectorId, setTimeout(async () => {
      state.timers.delete(sectorId);
      const t = team(sectorId);
      try {
        await api(`/api/admin/secteurs/${sectorId}/equipe`, jsonBody("PUT", t));
        flashSaved();
      } catch (err) {
        showToast(`Équipe non enregistrée : ${err.message}`, true);
        load().catch(() => {});
      }
    }, delay));
  }

  function changed(sectorId, { delay } = {}) {
    saveTeam(sectorId, delay);
    render();
  }

  // ---- Actions sur les équipes ------------------------------------------------------------

  /** Place une personne dans un secteur avec un rôle (la retire d'abord si elle y est déjà). */
  function placePerson(sectorId, personneId, role, { from } = {}) {
    if (from && from !== sectorId) removeMember(from, personneId, { silent: true });
    const t = team(sectorId);
    const existing = t.membres.find((m) => m.personne_id === personneId);
    if (existing) {
      if (existing.role === role) return;
      t.membres = t.membres.filter((m) => m !== existing);
    }
    t.membres.push({ personne_id: personneId, role });
    sortMembers(t);
    changed(sectorId);
    if (from && from !== sectorId) saveTeam(from);
  }

  function sortMembers(t) {
    // responsables d'abord, ordre d'arrivée conservé dans chaque rôle
    t.membres = [...t.membres.filter((m) => m.role === "responsable"), ...t.membres.filter((m) => m.role !== "responsable")];
  }

  function removeMember(sectorId, personneId, { silent } = {}) {
    const t = team(sectorId);
    t.membres = t.membres.filter((m) => m.personne_id !== personneId);
    if (!silent) changed(sectorId);
  }

  function toggleRole(sectorId, personneId) {
    const t = team(sectorId);
    const m = t.membres.find((x) => x.personne_id === personneId);
    if (!m) return;
    m.role = m.role === "responsable" ? "equipier" : "responsable";
    sortMembers(t);
    changed(sectorId);
  }

  // ---- Alertes et résumé ----------------------------------------------------------------

  function computeAlerts() {
    const alerts = [];
    const noResp = state.sectors.filter((s) => team(s.id).membres.length && !team(s.id).membres.some((m) => m.role === "responsable"));
    const empty = state.sectors.filter((s) => !team(s.id).membres.length);
    if (noResp.length) {
      alerts.push({ level: "warn", text: `Pas de responsable : ${noResp.map((s) => `<b>${escapeHtml(s.code)}</b> ${escapeHtml(s.nom)}`).join(", ")}.` });
    }
    if (empty.length && state.personnes.length) {
      alerts.push({ level: "info", text: `Personne n'est encore placé sur : ${empty.map((s) => `<b>${escapeHtml(s.code)}</b>`).join(", ")}.` });
    }
    // une même personne sur deux secteurs le même jour (et même créneau, ou journée entière)
    for (const p of state.personnes) {
      const list = assignmentsOf(p.id).filter((a) => team(a.sector.id).date);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = team(list[i].sector.id);
          const b = team(list[j].sector.id);
          const overlap = a.date === b.date
            && (!a.creneau || !b.creneau || a.creneau === b.creneau || a.creneau === "Journée" || b.creneau === "Journée");
          if (overlap) {
            alerts.push({ level: "danger", text: `<b>${escapeHtml(p.nom)}</b> est prévu(e) sur <b>${escapeHtml(list[i].sector.code)}</b> et <b>${escapeHtml(list[j].sector.code)}</b> le ${escapeHtml(formatDate(a.date))}${a.creneau && a.creneau === b.creneau ? ` (${escapeHtml(a.creneau.toLowerCase())})` : ""}` });
          }
        }
      }
    }
    return alerts;
  }

  function renderSummary() {
    const placed = new Set(Object.values(state.equipes).flatMap((t) => t.membres.map((m) => m.personne_id)));
    const withResp = state.sectors.filter((s) => team(s.id).membres.some((m) => m.role === "responsable")).length;
    const done = state.sectors.filter((s) => team(s.id).statut === "termine").length;
    const parts = [
      `${state.personnes.length} personne${state.personnes.length > 1 ? "s" : ""} (${[...placed].filter((id) => person(id)).length} placée${placed.size > 1 ? "s" : ""})`,
      `${withResp}/${state.sectors.length} secteurs avec responsable`,
      `${done}/${state.sectors.length} terminés`,
    ];
    els.summary.textContent = parts.join(" · ");
    els.alerts.innerHTML = computeAlerts().map((a) => `<div class="warning ${a.level}"><span class="warning-body">${a.text}</span></div>`).join("");
  }

  // ---- Liste des personnes ---------------------------------------------------------------

  function renderPeople() {
    const q = els.filter.value.trim().toLowerCase();
    const onlyFree = els.free.checked;
    els.count.textContent = String(state.personnes.length);
    const rows = state.personnes.filter((p) => {
      if (q && !p.nom.toLowerCase().includes(q)) return false;
      if (onlyFree && assignmentsOf(p.id).length) return false;
      return true;
    });
    if (!state.personnes.length) {
      els.list.innerHTML = `<li class="people-empty">Ajoutez les membres de la caserne qui participent à la tournée.</li>`;
      return;
    }
    if (!rows.length) {
      els.list.innerHTML = `<li class="people-empty">Aucune personne ne correspond.</li>`;
      return;
    }
    els.list.innerHTML = rows.map((p) => {
      if (state.editing === p.id) {
        return `<li class="person-row editing" data-id="${p.id}">
          <form class="person-edit">
            <input name="nom" value="${escapeHtml(p.nom)}" maxlength="80" required aria-label="Nom" />
            <input name="telephone" type="tel" value="${escapeHtml(p.telephone)}" maxlength="30" placeholder="Téléphone" aria-label="Téléphone" />
            <span class="person-edit-actions">
              <button class="btn small primary" type="submit">OK</button>
              <button class="btn small" type="button" data-action="cancel">Annuler</button>
            </span>
          </form>
        </li>`;
      }
      const tags = assignmentsOf(p.id).map((a) => `<span class="assign-tag${a.role === "responsable" ? " lead" : ""}" style="--c:${a.sector.couleur}" title="${escapeHtml(a.sector.nom)}">${a.role === "responsable" ? "★ " : ""}${escapeHtml(a.sector.code)}</span>`).join("");
      return `<li class="person-row" data-id="${p.id}" draggable="true">
        ${avatar(p)}
        <span class="person-main">
          <span class="person-name">${escapeHtml(p.nom)}</span>
          <span class="person-sub">${p.telephone ? `<a href="${telHref(p.telephone)}">${escapeHtml(p.telephone)}</a>` : `<span class="hint-inline">pas de téléphone</span>`}${p.acces_envoye_le ? ` <span class="sent-tag" title="Code envoyé par WhatsApp le ${new Date(p.acces_envoye_le).toLocaleString("fr-FR")}">📲</span>` : ""}${tags ? ` <span class="assign-tags">${tags}</span>` : ` <span class="free-tag">libre</span>`}</span>
        </span>
        <span class="person-actions">
          <button class="icon-btn key-btn" type="button" data-action="access" title="Code d'accès personnel" aria-label="Code d'accès de ${escapeHtml(p.nom)}"><svg class="ico" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M15 8l2 2" /></svg></button>
          <button class="icon-btn" type="button" data-action="edit" title="Modifier" aria-label="Modifier ${escapeHtml(p.nom)}"><svg class="ico" viewBox="0 0 24 24"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></svg></button>
          <button class="icon-btn danger" type="button" data-action="delete" title="Supprimer" aria-label="Supprimer ${escapeHtml(p.nom)}"><svg class="ico" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg></button>
        </span>
      </li>`;
    }).join("");
  }

  // ---- Fiches des secteurs ---------------------------------------------------------------

  function memberChip(sectorId, m) {
    const p = person(m.personne_id);
    if (!p) return "";
    const lead = m.role === "responsable";
    return `<span class="member-chip${lead ? " lead" : ""}" draggable="true" data-personne="${p.id}" data-sector="${sectorId}">
      ${avatar(p, "sm")}
      <span class="member-name">${escapeHtml(p.nom)}</span>
      ${p.telephone ? `<a class="member-tel" href="${telHref(p.telephone)}" title="${escapeHtml(p.telephone)}" aria-label="Appeler ${escapeHtml(p.nom)}"><svg class="ico" viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2" /></svg></a>` : ""}
      <button class="chip-btn" type="button" data-action="role" title="${lead ? "Passer équipier" : "Nommer responsable"}" aria-label="${lead ? "Passer équipier" : "Nommer responsable"}">${lead ? "★" : "☆"}</button>
      <button class="chip-btn" type="button" data-action="remove" title="Retirer du secteur" aria-label="Retirer ${escapeHtml(p.nom)}">×</button>
    </span>`;
  }

  function addOptions(sectorId) {
    const t = team(sectorId);
    const inTeam = new Set(t.membres.map((m) => m.personne_id));
    const free = [];
    const busy = [];
    for (const p of state.personnes) {
      if (inTeam.has(p.id)) continue;
      const where = assignmentsOf(p.id).map((a) => a.sector.code);
      (where.length ? busy : free).push(`<option value="${p.id}">${escapeHtml(p.nom)}${where.length ? ` — déjà en ${escapeHtml(where.join(", "))}` : ""}</option>`);
    }
    if (!free.length && !busy.length) return "";
    return `<option value="">+ Ajouter…</option>`
      + (free.length ? `<optgroup label="Sans secteur">${free.join("")}</optgroup>` : "")
      + (busy.length ? `<optgroup label="Déjà placés ailleurs">${busy.join("")}</optgroup>` : "");
  }

  function roleZone(s, role) {
    const t = team(s.id);
    const members = t.membres.filter((m) => m.role === role);
    const options = addOptions(s.id);
    return `<div class="role-zone" data-role="${role}" data-sector="${s.id}">
      <div class="role-head">
        <span class="role-label">${role === "responsable" ? "★ " : ""}${ROLE_LABEL[role]}${role === "equipier" && members.length ? ` <span class="role-count">${members.length}</span>` : ""}</span>
        ${options ? `<select class="add-member" data-role="${role}" aria-label="Ajouter : ${ROLE_LABEL[role].toLowerCase()}">${options}</select>` : ""}
      </div>
      <div class="chips">${members.map((m) => memberChip(s.id, m)).join("") || `<span class="drop-hint">${role === "responsable" ? "Aucun responsable" : "Aucun équipier"}</span>`}</div>
    </div>`;
  }

  function renderCards() {
    if (!state.sectors.length) {
      els.cards.innerHTML = `<p class="empty">Aucun secteur enregistré : dessinez et enregistrez d'abord les secteurs (onglet « Secteurs »).</p>`;
      return;
    }
    let html = "";
    let commune = null;
    for (const s of state.sectors) {
      if (s.commune !== commune) {
        commune = s.commune;
        html += `<h3 class="commune-heading team-commune">${escapeHtml(commune)}</h3>`;
      }
      const t = team(s.id);
      const lead = t.membres.some((m) => m.role === "responsable");
      html += `<article class="team-card statut-${t.statut}" style="--c:${s.couleur}" data-sector="${s.id}">
        <header class="team-card-head">
          <b class="sector-code" style="background:${s.couleur}">${escapeHtml(s.code)}</b>
          <span class="team-card-title">
            <span class="team-card-name">${escapeHtml(s.nom)}</span>
            <span class="team-card-meta">${s.nbAdresses} adresses${s.hameaux ? ` · ${escapeHtml(s.hameaux)}` : ""}</span>
          </span>
          <select class="statut-select statut-${t.statut}" data-field="statut" aria-label="Avancement">
            ${Object.entries(STATUTS).map(([k, v]) => `<option value="${k}"${k === t.statut ? " selected" : ""}>${v}</option>`).join("")}
          </select>
        </header>
        <div class="team-when">
          <label><span>Date</span><input type="date" data-field="date" value="${escapeHtml(t.date)}" /></label>
          <label><span>Créneau</span><select data-field="creneau">
            <option value="">—</option>
            ${CRENEAUX.map((c) => `<option${c === t.creneau ? " selected" : ""}>${c}</option>`).join("")}
            ${t.creneau && !CRENEAUX.includes(t.creneau) ? `<option selected>${escapeHtml(t.creneau)}</option>` : ""}
          </select></label>
        </div>
        ${roleZone(s, "responsable")}
        ${roleZone(s, "equipier")}
        <textarea class="team-note" data-field="note" rows="2" maxlength="500" placeholder="Consignes : point de rendez-vous, clés, véhicule…">${escapeHtml(t.note)}</textarea>
        ${t.membres.length && !lead ? `<p class="team-warn">Nommez un responsable avec ☆.</p>` : ""}
      </article>`;
    }
    els.cards.innerHTML = html;
  }

  function render() {
    if (!state.loaded) return;
    // ne pas reconstruire une zone de saisie pendant qu'on tape dedans
    const active = document.activeElement;
    const typingNote = active && active.classList.contains("team-note") ? { sector: active.closest(".team-card").dataset.sector, pos: active.selectionStart } : null;
    renderSummary();
    renderPeople();
    renderCards();
    if (typingNote) {
      const el = els.cards.querySelector(`.team-card[data-sector="${typingNote.sector}"] .team-note`);
      if (el) { el.focus(); el.setSelectionRange(typingNote.pos, typingNote.pos); }
    }
  }

  // ---- Évènements : personnes -------------------------------------------------------------

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nom = els.name.value.trim();
    if (!nom) return;
    try {
      const { personnes } = await api("/api/admin/personnes", jsonBody("POST", { personnes: [{ nom, telephone: els.tel.value.trim() }] }));
      state.personnes.push(...personnes);
      state.personnes.sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
      els.name.value = "";
      els.tel.value = "";
      els.name.focus();
      flashSaved();
      render();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  els.bulkAdd.addEventListener("click", async () => {
    const known = new Set(state.personnes.map((p) => p.nom.toLowerCase()));
    const items = els.bulk.value.split("\n").map((line) => {
      const [nom, telephone = ""] = line.split(/[;\t]/);
      return { nom: (nom || "").replace(/\s+/g, " ").trim(), telephone: telephone.trim() };
    }).filter((p) => p.nom && !known.has(p.nom.toLowerCase()));
    if (!items.length) { showToast("Aucun nouveau nom dans la liste."); return; }
    try {
      const { personnes } = await api("/api/admin/personnes", jsonBody("POST", { personnes: items }));
      state.personnes.push(...personnes);
      state.personnes.sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
      els.bulk.value = "";
      els.bulk.closest("details").open = false;
      showToast(`${personnes.length} personne${personnes.length > 1 ? "s" : ""} ajoutée${personnes.length > 1 ? "s" : ""}.`);
      render();
    } catch (err) {
      showToast(`${err.message} (un téléphone mal écrit ?)`, true);
    }
  });

  els.filter.addEventListener("input", renderPeople);
  els.free.addEventListener("change", renderPeople);

  els.list.addEventListener("click", async (e) => {
    const row = e.target.closest(".person-row");
    const btn = e.target.closest("[data-action]");
    if (!row || !btn) return;
    const id = Number(row.dataset.id);
    const p = person(id);
    if (btn.dataset.action === "edit") { state.editing = id; renderPeople(); els.list.querySelector(".editing input")?.focus(); }
    if (btn.dataset.action === "cancel") { state.editing = null; renderPeople(); }
    if (btn.dataset.action === "access") openAccess(p);
    if (btn.dataset.action === "delete") {
      const where = assignmentsOf(id).map((a) => a.sector.code);
      if (!confirm(`Supprimer ${p.nom} de la liste${where.length ? ` et de ${where.join(", ")}` : ""} ?`)) return;
      try {
        await api(`/api/admin/personnes/${id}`, { method: "DELETE" });
        state.personnes = state.personnes.filter((x) => x.id !== id);
        for (const t of Object.values(state.equipes)) t.membres = t.membres.filter((m) => m.personne_id !== id);
        flashSaved();
        render();
      } catch (err) {
        showToast(err.message, true);
      }
    }
  });

  els.list.addEventListener("submit", async (e) => {
    e.preventDefault();
    const row = e.target.closest(".person-row");
    const id = Number(row.dataset.id);
    const form = new FormData(e.target);
    try {
      const updated = await api(`/api/admin/personnes/${id}`, jsonBody("PUT", { nom: form.get("nom"), telephone: form.get("telephone") }));
      Object.assign(person(id), updated);
      state.personnes.sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
      state.editing = null;
      flashSaved();
      render();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // ---- Évènements : fiches des secteurs ----------------------------------------------------

  els.cards.addEventListener("change", (e) => {
    const card = e.target.closest(".team-card");
    if (!card) return;
    const sectorId = Number(card.dataset.sector);
    if (e.target.classList.contains("add-member")) {
      const pid = Number(e.target.value);
      if (pid) placePerson(sectorId, pid, e.target.dataset.role);
      return;
    }
    const field = e.target.dataset.field;
    if (field && field !== "note") {
      team(sectorId)[field] = e.target.value;
      changed(sectorId, { delay: 0 });
    }
  });

  els.cards.addEventListener("input", (e) => {
    if (!e.target.classList.contains("team-note")) return;
    const sectorId = Number(e.target.closest(".team-card").dataset.sector);
    team(sectorId).note = e.target.value;
    saveTeam(sectorId, 700); // pas de re-rendu pendant la frappe
  });

  els.cards.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip-btn");
    if (!btn) return;
    const chip = btn.closest(".member-chip");
    const sectorId = Number(chip.dataset.sector);
    const pid = Number(chip.dataset.personne);
    if (btn.dataset.action === "remove") removeMember(sectorId, pid);
    if (btn.dataset.action === "role") toggleRole(sectorId, pid);
  });

  // ---- Glisser-déposer (ordinateur) -------------------------------------------------------

  document.addEventListener("dragstart", (e) => {
    const source = e.target.closest?.(".person-row[draggable], .member-chip[draggable]");
    if (!source || !els.view.contains(source)) return;
    const pid = source.dataset.id || source.dataset.personne;
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ pid: Number(pid), from: source.dataset.sector ? Number(source.dataset.sector) : null }));
    e.dataTransfer.setData("text/plain", person(Number(pid))?.nom || "");
    e.dataTransfer.effectAllowed = "copyMove";
    els.view.classList.add("dragging");
  });
  document.addEventListener("dragend", () => {
    els.view.classList.remove("dragging");
    els.cards.querySelectorAll(".drop-over").forEach((z) => z.classList.remove("drop-over"));
  });
  els.cards.addEventListener("dragover", (e) => {
    const zone = e.target.closest(".role-zone");
    if (!zone || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    els.cards.querySelectorAll(".drop-over").forEach((z) => z !== zone && z.classList.remove("drop-over"));
    zone.classList.add("drop-over");
  });
  els.cards.addEventListener("dragleave", (e) => {
    const zone = e.target.closest(".role-zone");
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove("drop-over");
  });
  els.cards.addEventListener("drop", (e) => {
    const zone = e.target.closest(".role-zone");
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove("drop-over");
    let info;
    try { info = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)); } catch { return; }
    // depuis une autre fiche : la personne change de secteur ; depuis la liste : elle est ajoutée
    placePerson(Number(zone.dataset.sector), info.pid, zone.dataset.role, { from: info.from });
  });
  // déposer une puce sur la liste des personnes la retire de son secteur
  els.list.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
  });
  els.list.addEventListener("drop", (e) => {
    e.preventDefault();
    let info;
    try { info = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)); } catch { return; }
    if (info.from) removeMember(info.from, info.pid);
  });

  // ---- Réglages publics -----------------------------------------------------------------

  async function saveSetting(body) {
    try {
      const s = await api("/api/admin/settings", jsonBody("PUT", body));
      els.pubTeams.checked = s.equipes_public;
      els.pubTels.checked = s.telephones_public;
      els.pubTels.disabled = !s.equipes_public;
      flashSaved();
    } catch (err) {
      showToast(err.message, true);
    }
  }
  els.pubTeams.addEventListener("change", () => saveSetting({ equipes_public: els.pubTeams.checked }));
  els.pubTels.addEventListener("change", () => saveSetting({ telephones_public: els.pubTels.checked }));

  // ---- Export tableur (CSV lisible par Excel / LibreOffice) -----------------------------------

  els.exportBtn.addEventListener("click", () => {
    // guillemets doublés, et pas de formule Excel cachée dans un nom ou une note (=, +, -, @)
      const cell = (v) => `"${String(v ?? "").replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;
    const names = (t, role) => t.membres.filter((m) => m.role === role).map((m) => person(m.personne_id)?.nom).filter(Boolean).join(", ");
    const tels = (t) => t.membres.map((m) => person(m.personne_id)).filter((p) => p && p.telephone).map((p) => `${p.nom} : ${p.telephone}`).join(" / ");
    const rows = [["Commune", "Code", "Secteur", "Adresses", "Date", "Créneau", "Avancement", "Responsable(s)", "Équipiers", "Téléphones", "Consignes"]];
    for (const s of state.sectors) {
      const t = team(s.id);
      rows.push([s.commune, s.code, s.nom, s.nbAdresses, t.date ? new Date(`${t.date}T12:00:00`).toLocaleDateString("fr-FR") : "", t.creneau,
        STATUTS[t.statut], names(t, "responsable"), names(t, "equipier"), tels(t), t.note]);
    }
    const csv = "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `equipes-tournee.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

  // ---- Accès personnel (code / lien à envoyer à chacun) --------------------------------------

  const accessDialog = $("access-dialog");
  let accessFor = null;

  const formatCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
  const accessLink = (p) => `${location.origin}/equipe#acces=${p.code}`;

  /** Numéro au format international pour WhatsApp (06… -> 336…). */
  function intlPhone(tel) {
    let d = String(tel || "").replace(/[^0-9+]/g, "");
    if (d.startsWith("+")) return d.slice(1);
    if (d.startsWith("00")) return d.slice(2);
    if (d.startsWith("0") && d.length === 10) return `33${d.slice(1)}`;
    return d;
  }

  function accessMessage(p) {
    const first = p.nom.split(" ")[0];
    const where = assignmentsOf(p.id).map((a) => `${a.sector.code} ${a.sector.nom}${a.role === "responsable" ? " (responsable)" : ""}`).join(", ");
    return `Bonjour ${first}, voici ton accès personnel pour la ${window.Common.tourneeTitle(state.annee).toLowerCase()} des pompiers de Courzieu${where ? `, secteur ${where}` : ""} :\n${accessLink(p)}\n\nOu bien saisis le code ${formatCode(p.code)} dans « Espace équipe ». Il est personnel : ne le transfère pas.`;
  }

  function fillAccess() {
    const p = person(accessFor);
    if (!p) { accessDialog.close(); return; }
    const msg = encodeURIComponent(accessMessage(p));
    $("access-title").textContent = `Accès de ${p.nom}`;
    $("access-code").textContent = formatCode(p.code);
    $("access-link").value = accessLink(p);
    $("access-whatsapp").href = `https://wa.me/${intlPhone(p.telephone)}?text=${msg}`;
    $("access-sms").href = `sms:${(p.telephone || "").replace(/[^0-9+]/g, "")}?&body=${msg}`;
  }

  function openAccess(p) {
    accessFor = p.id;
    fillAccess();
    accessDialog.showModal();
  }

  $("access-copy").addEventListener("click", async () => {
    const p = person(accessFor);
    try {
      await navigator.clipboard.writeText(accessMessage(p));
      showToast("Message avec le lien copié ✓");
    } catch {
      $("access-link").select();
      showToast("Sélectionnez puis copiez le lien.");
    }
  });

  $("access-regen").addEventListener("click", async () => {
    const p = person(accessFor);
    if (!confirm(`Changer le code de ${p.nom} ? L'ancien code et le lien déjà envoyé ne marcheront plus (il faudra lui renvoyer le nouveau).`)) return;
    try {
      const updated = await api(`/api/admin/personnes/${p.id}/code`, { method: "POST" });
      Object.assign(p, updated);
      fillAccess();
      flashSaved();
      showToast("Nouveau code créé : pensez à l'envoyer.");
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // ---- Envoi groupé des accès par le bot WhatsApp ---------------------------------------------

  const sendDialog = $("send-dialog");
  const send = { picked: new Set(), running: false, stop: false, results: new Map(), settings: null, previewTimer: null };
  const hasPhone = (p) => String(p.telephone || "").replace(/\D/g, "").length >= 8;
  const sentLabel = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

  async function refreshBotState() {
    const el = $("send-bot-state");
    el.className = "bot-state";
    el.textContent = "…";
    try {
      const st = await api("/api/admin/whatsapp/etat");
      el.classList.add(st.pret ? "ok" : "ko");
      el.textContent = st.pret ? "● Bot connecté" : `● ${st.erreur}`;
      if (!st.configure) $("send-bot").open = true;
      send.ready = st.pret;
    } catch (err) {
      el.classList.add("ko");
      el.textContent = `● ${err.message}`;
      send.ready = false;
    }
    updateSendButton();
  }

  function renderSendList() {
    const rows = state.personnes.map((p) => {
      const ok = hasPhone(p);
      const res = send.results.get(p.id);
      const where = assignmentsOf(p.id).map((a) => `${a.role === "responsable" ? "★ " : ""}${a.sector.code}`).join(" ");
      const status = res ? (res.ok ? `<span class="send-ok">✓ envoyé</span>` : res.pending ? `<span class="hint">⏳ envoi…</span>` : `<span class="send-ko" title="${escapeHtml(res.error)}">✕ ${escapeHtml(res.error)}</span>`)
        : p.acces_envoye_le ? `<span class="hint">envoyé le ${sentLabel(p.acces_envoye_le)}</span>` : `<span class="hint">jamais envoyé</span>`;
      return `<li class="${ok ? "" : "disabled"}"><label>
          <input type="checkbox" data-id="${p.id}" ${send.picked.has(p.id) ? "checked" : ""} ${ok && !send.running ? "" : "disabled"} />
          <span class="send-who"><b>${escapeHtml(p.nom)}</b><small>${ok ? escapeHtml(p.telephone) : "pas de téléphone"}${where ? ` · ${escapeHtml(where)}` : ""}</small></span>
          <span class="send-status">${status}</span></label></li>`;
    });
    $("send-list").innerHTML = rows.join("") || `<li class="hint">Ajoutez d'abord des personnes.</li>`;
    updateSendButton();
  }

  function updateSendButton() {
    const n = send.picked.size;
    $("send-go").disabled = send.running ? false : !n || !send.ready;
    $("send-go").textContent = send.running ? "Arrêter" : `Envoyer à ${n} personne${n > 1 ? "s" : ""}`;
    $("send-go").classList.toggle("danger", send.running);
  }

  function pick(kind) {
    const eligible = state.personnes.filter(hasPhone);
    const pickers = {
      all: () => eligible,
      none: () => [],
      never: () => eligible.filter((p) => !p.acces_envoye_le),
      lead: () => eligible.filter((p) => assignmentsOf(p.id).some((a) => a.role === "responsable")),
    };
    send.picked = new Set(pickers[kind]().map((p) => p.id));
    renderSendList();
    schedulePreview();
  }

  function schedulePreview() {
    clearTimeout(send.previewTimer);
    send.previewTimer = setTimeout(renderPreview, 250);
  }

  async function renderPreview() {
    const first = state.personnes.find((p) => send.picked.has(p.id)) || state.personnes.find(hasPhone) || state.personnes[0];
    if (!first) { $("send-preview").textContent = ""; return; }
    $("send-preview-who").textContent = `Aperçu pour ${first.nom}`;
    try {
      const r = await api("/api/admin/whatsapp/apercu", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personne_id: first.id, origin: location.origin, modele: $("send-template").value }),
      });
      $("send-preview").innerHTML = waFormat(r.message);
    } catch (err) {
      $("send-preview").textContent = err.message;
    }
  }

  /** Mise en forme façon WhatsApp : *gras*, _italique_, liens. */
  function waFormat(text) {
    return escapeHtml(text)
      .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
      .replace(/(^|\s)_([^_\n]+)_/g, "$1<i>$2</i>")
      .replace(/(https?:\/\/[^\s<]+)/g, '<span class="wa-link">$1</span>')
      .replace(/\n/g, "<br>");
  }

  async function saveSendSettings(extra) {
    send.settings = await api("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(extra) });
    return send.settings;
  }

  $("send-open").addEventListener("click", async () => {
    send.results.clear();
    send.picked = new Set(state.personnes.filter((p) => hasPhone(p) && !p.acces_envoye_le).map((p) => p.id));
    $("send-error").hidden = true;
    $("send-progress").hidden = true;
    $("send-sector").innerHTML = `<option value="">Un secteur…</option>${state.sectors.map((s) => `<option value="${s.id}">${escapeHtml(s.code)} ${escapeHtml(s.nom)}</option>`).join("")}`;
    sendDialog.showModal();
    renderSendList();
    try {
      send.settings = await api("/api/admin/settings");
      $("send-url").value = send.settings.whatsapp_bot_url;
      $("send-key").value = "";
      $("send-key").placeholder = send.settings.whatsapp_bot_key_set ? "réglée (laisser vide pour la garder)" : "aucune";
      $("send-template").value = send.settings.whatsapp_message;
      $("send-bot").open = !send.settings.whatsapp_bot_url;
    } catch (err) { showToast(err.message, true); }
    renderPreview();
    refreshBotState();
  });

  $("send-list").addEventListener("change", (e) => {
    const id = Number(e.target.dataset.id);
    if (!id) return;
    if (e.target.checked) send.picked.add(id); else send.picked.delete(id);
    updateSendButton();
    schedulePreview();
  });
  sendDialog.querySelector(".send-quick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pick]");
    if (b && !send.running) pick(b.dataset.pick);
  });
  $("send-sector").addEventListener("change", () => {
    const sid = Number($("send-sector").value);
    if (!sid || send.running) return;
    send.picked = new Set(team(sid).membres.map((m) => person(m.personne_id)).filter((p) => p && hasPhone(p)).map((p) => p.id));
    $("send-sector").value = "";
    renderSendList();
    schedulePreview();
  });
  $("send-template").addEventListener("input", schedulePreview);
  $("send-reset").addEventListener("click", () => {
    if (send.settings) $("send-template").value = send.settings.whatsapp_message_defaut;
    schedulePreview();
  });
  $("send-test").addEventListener("click", async () => {
    const body = { whatsapp_bot_url: $("send-url").value.trim() };
    if ($("send-key").value) body.whatsapp_bot_key = $("send-key").value;
    try {
      await saveSendSettings(body);
      $("send-key").value = "";
      $("send-key").placeholder = send.settings.whatsapp_bot_key_set ? "réglée (laisser vide pour la garder)" : "aucune";
      flashSaved();
    } catch (err) { showToast(err.status === 422 ? "Adresse du bot invalide (ex. http://192.168.1.20:3000)" : err.message, true); return; }
    await refreshBotState();
  });
  $("send-close").addEventListener("click", () => { send.stop = true; sendDialog.close(); });
  sendDialog.addEventListener("cancel", (e) => { if (send.running) e.preventDefault(); });

  $("send-go").addEventListener("click", async () => {
    if (send.running) { send.stop = true; return; }
    const ids = state.personnes.filter((p) => send.picked.has(p.id)).map((p) => p.id);
    if (!ids.length) return;
    if (!confirm(`Envoyer son code d'accès par WhatsApp à ${ids.length} personne${ids.length > 1 ? "s" : ""} ?`)) return;
    try {
      if ($("send-template").value.trim() !== (send.settings ? send.settings.whatsapp_message.trim() : "")) {
        await saveSendSettings({ whatsapp_message: $("send-template").value });
      }
    } catch (err) { showToast(err.message, true); return; }
    send.running = true;
    send.stop = false;
    $("send-error").hidden = true;
    let ok = 0;
    let ko = 0;
    for (const [i, id] of ids.entries()) {
      if (send.stop) break;
      const p = person(id);
      send.results.set(id, { pending: true });
      $("send-progress").hidden = false;
      $("send-progress").textContent = `Envoi ${i + 1} / ${ids.length} : ${p.nom}…`;
      renderSendList();
      try {
        const r = await fetchJSON("/api/admin/whatsapp/envoyer", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personne_id: id, origin: location.origin }),
        });
        p.acces_envoye_le = r.acces_envoye_le;
        send.results.set(id, { ok: true });
        send.picked.delete(id);
        ok++;
      } catch (err) {
        send.results.set(id, { ok: false, error: err.message });
        ko++;
        if (err.status === 401) { state.onUnauthorized(); break; }
        // bot arrêté ou injoignable : inutile de continuer la liste
        if ([409, 503, 504].includes(err.status)) {
          $("send-error").textContent = err.message;
          $("send-error").hidden = false;
          break;
        }
      }
      // un petit temps entre deux messages, comme un envoi à la main (WhatsApp n'aime pas les rafales)
      if (i < ids.length - 1 && !send.stop) await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
    }
    send.running = false;
    $("send-progress").textContent = `${ok} message${ok > 1 ? "s" : ""} envoyé${ok > 1 ? "s" : ""}${ko ? ` · ${ko} échec${ko > 1 ? "s" : ""}` : ""}${send.stop ? " · arrêté" : ""}.`;
    renderSendList();
    renderPeople();
  });

  // ---- Interface avec admin.js ------------------------------------------------------------

  window.Equipes = {
    async open({ onUnauthorized } = {}) {
      if (onUnauthorized) state.onUnauthorized = onUnauthorized;
      await load();
    },
  };
})();
