/* Espace équipe (téléphone) : récapitulatif du secteur, carte, maisons, caisse, équipe,
   et mode « maison suivante ». Réservé aux personnes connectées avec leur code personnel. */
(() => {
  "use strict";
  const C = window.Common;
  const {
    escapeHtml, fetchJSON, showToast, toPolys, outerRings, holeRings, addBaseLayers, sectorCode, euros, parseEuros,
    navLinks, personAvatar, formatDay, telHref, statutPill, tourneeTitle, formatDistance, normalizeText, IS_IOS,
  } = C;
  const $ = (id) => document.getElementById(id);

  const STATUS = {
    fait: { label: "Fait", icon: "✓", color: "#16a34a" },
    absent: { label: "Absent", icon: "⏳", color: "#d97706" },
    refus: { label: "Refus", icon: "✕", color: "#dc2626" },
  };
  const TODO_COLOR = "#475569";
  const MODE_LABEL = { especes: "espèces", cheque: "chèque", cb: "carte" };
  const QUEUE_KEY = "pompiers-pending-updates";
  const SECTOR_KEY = "terrain-secteur";
  const WORLD = [[85, -180], [85, 180], [-85, 180], [-85, -180]];
  const TABS = ["accueil", "carte", "maisons", "caisse", "equipe"];

  const storage = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* indisponible */ } },
  };

  const T = {
    me: null,
    annee: null,
    sectors: [], // [{slug, communeNom, sector, role}]
    allSectors: new Map(), // id -> {code, nom} de tous les secteurs (pour « déjà prévu sur C3 »)
    cur: null,
    tr: null, // suivi du secteur choisi
    addr: new Map(), // id -> adresse
    filter: "todo",
    query: "",
    map: null,
    layer: null,
    markers: new Map(),
    fitted: false,
    myPos: null,
    watch: null,
    tour: { active: false, current: null, skipped: new Set(), last: null },
  };

  // ---------------------------------------------------------------------------------------
  // Connexion
  // ---------------------------------------------------------------------------------------

  function showLogin(message) {
    $("t-app").hidden = true;
    $("t-login").hidden = false;
    $("t-login-error").hidden = !message;
    if (message) $("t-login-error").textContent = message;
    $("t-code").focus();
  }

  async function login(code) {
    await fetchJSON("/api/equipe/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
  }

  $("t-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await login($("t-code").value);
      $("t-code").value = "";
      await start();
    } catch (err) {
      showLogin(err.message);
    }
  });

  // ---------------------------------------------------------------------------------------
  // Chargement
  // ---------------------------------------------------------------------------------------

  async function loadSectors() {
    const index = await fetchJSON("/api/communes");
    T.annee = index.annee;
    $("t-login-title").textContent = tourneeTitle(index.annee);
    const datas = await Promise.all(index.communes.map((c) => fetchJSON(`/api/communes/${encodeURIComponent(c.slug)}`)));
    const roles = new Map(T.me.secteurs.map((x) => [x.sector_id, x.role]));
    T.sectors = [];
    for (const d of datas) {
      d.sectors.forEach((s, i) => {
        s.code = sectorCode(d.commune.nom, i);
        T.allSectors.set(s.id, { code: s.code, nom: s.nom });
        if (T.me.admin || roles.has(s.id)) {
          T.sectors.push({ slug: d.commune.slug, communeNom: d.commune.nom, sector: s, role: T.me.admin ? "admin" : roles.get(s.id) });
        }
      });
    }
  }

  async function start() {
    try {
      T.me = await fetchJSON("/api/equipe/moi");
    } catch (err) {
      if (err.status === 401) { showLogin(); return; }
      throw err;
    }
    $("t-login").hidden = true;
    $("t-app").hidden = false;
    await loadSectors();
    if (!T.sectors.length) {
      document.body.classList.add("t-no-sector");
      $("v-accueil").innerHTML = `<div class="r-empty">
        <h2>Bonjour ${escapeHtml(firstName())} 👋</h2>
        <p>Vous n'êtes pas encore placé(e) dans une équipe. Le chef de tournée vous ajoutera à un secteur.</p>
        <a class="btn" href="/">Voir le plan des secteurs</a>
        <button type="button" class="btn" data-action="logout">Se déconnecter</button></div>`;
      $("t-sector").innerHTML = "<span>Aucun secteur</span>";
      showTab("accueil");
      return;
    }
    const saved = Number(storage.get(SECTOR_KEY, ""));
    const pick = T.sectors.find((x) => x.sector.id === saved)
      || T.sectors.find((x) => x.role === "responsable") || T.sectors[0];
    await selectSector(pick);
    flushQueue();
    showTab(currentTab());
  }

  async function selectSector(item) {
    T.cur = item;
    storage.set(SECTOR_KEY, String(item.sector.id));
    T.addr = new Map(item.sector.addresses.map((a) => [a.id, a]));
    T.fitted = false;
    T.tr = null;
    await loadTracking();
    renderAll();
  }

  async function loadTracking() {
    const s = T.cur.sector;
    if (!T.me.suivi) {
      const equipe = await fetchJSON(`/api/equipe/secteurs/${s.id}/equipe`).catch(() => s.equipe || null);
      if (T.cur.sector !== s) return;
      T.tr = { readOnly: true, role: T.cur.role, lead: T.cur.role !== "equipier", full: T.cur.role !== "equipier", donsActive: false, dons: new Map(), precedent: {}, equipe };
      return;
    }
    const t = await fetchJSON(`/api/equipe/secteurs/${s.id}/suivi`);
    const lead = t.role !== "equipier";
    const caisse = lead && t.dons !== null ? await fetchJSON(`/api/equipe/secteurs/${s.id}/caisse`).catch(() => null) : null;
    if (T.cur.sector !== s) return; // secteur changé entre-temps
    // les modifications pas encore envoyées (hors réseau) restent prioritaires
    const pending = new Map(readQueue().filter((q) => q.slug === T.cur.slug).map((q) => [q.addressId, q.status]));
    for (const a of s.addresses) {
      a.status = pending.has(a.id) ? pending.get(a.id) : (t.statuses[a.id] || {}).status || null;
    }
    const dons = new Map();
    for (const d of t.dons || []) {
      if (!dons.has(d.address_id)) dons.set(d.address_id, []);
      dons.get(d.address_id).push(d);
    }
    T.tr = {
      readOnly: false, role: t.role, lead, full: lead, donsActive: t.dons !== null, dons, allDons: t.dons || [],
      totaux: t.totaux, precedent: t.precedent || {}, equipe: t.equipe, caisse,
    };
  }

  async function reload() {
    if (!T.cur) return;
    try {
      await loadTracking();
      renderAll();
    } catch (err) {
      if (err.status === 401) { showToast("Accès expiré : reconnectez-vous.", true); showLogin(); }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Petits calculs
  // ---------------------------------------------------------------------------------------

  function firstName() {
    if (T.me && T.me.personne) return T.me.personne.nom.split(" ")[0];
    return "chef";
  }

  function counts() {
    const c = { fait: 0, absent: 0, refus: 0, todo: 0, total: 0 };
    for (const a of T.cur.sector.addresses) {
      c[a.status || "todo"]++;
      c.total++;
    }
    return c;
  }

  function plural(n, word) { return `${n} ${word}${n > 1 ? "s" : ""}`; }

  function myDons() {
    return (T.tr.allDons || []).filter((d) => d.mine);
  }

  function prevChip(a) {
    const p = T.tr && T.tr.precedent[a.id];
    if (!p) return "";
    const what = p.status === "refus" ? "refus" : p.status === "absent" ? "absent"
      : p.nb_dons ? (p.montant !== undefined ? `don de ${euros(p.montant)}` : "a donné") : "fait";
    const cls = p.status === "refus" ? "refus" : p.status === "absent" ? "absent" : "ok";
    return `<span class="prev-year prev-${cls}">${p.annee} : ${what}</span>`;
  }

  function donBadges(addressId) {
    const list = T.tr && T.tr.dons.get(addressId);
    if (!list || !list.length) return "";
    return list.map((d) => {
      const amount = d.montant !== undefined ? euros(d.montant) : "Don";
      const cls = d.statut === "ok" ? "ok" : d.statut === "attente" ? "wait" : "fail";
      const tail = d.statut === "attente" ? " · en attente" : d.statut === "echec" ? " · échoué" : "";
      return `<span class="don-badge ${cls}">${amount} ${MODE_LABEL[d.mode]}${tail}</span>`;
    }).join("");
  }

  function sortedAddresses() {
    const cmp = (x, y) => String(x || "").localeCompare(String(y || ""), "fr", { numeric: true });
    return [...T.cur.sector.addresses].sort((a, b) => cmp(a.groupe, b.groupe) || cmp(a.nom_voie, b.nom_voie) || cmp(a.numero, b.numero));
  }

  function distanceM(a, b) {
    const k = Math.PI / 180;
    const x = (b[1] - a[1]) * k * Math.cos(((a[0] + b[0]) / 2) * k);
    const y = (b[0] - a[0]) * k;
    return Math.hypot(x, y) * 6371000;
  }

  function canEdit() {
    return T.tr && !T.tr.readOnly;
  }

  // ---------------------------------------------------------------------------------------
  // Onglets
  // ---------------------------------------------------------------------------------------

  function currentTab() {
    const h = location.hash.replace("#", "");
    return TABS.includes(h) ? h : "accueil";
  }

  function showTab(name) {
    if (name === "caisse" && !(T.tr && T.tr.donsActive)) name = "accueil";
    for (const v of document.querySelectorAll(".t-view")) v.hidden = v.dataset.view !== name;
    for (const a of document.querySelectorAll(".t-tabs a")) a.classList.toggle("active", a.dataset.tab === name);
    document.body.dataset.tab = name;
    if (name === "carte") ensureMap();
    $("t-main").scrollTop = 0;
  }

  window.addEventListener("hashchange", () => {
    if (/acces=/.test(location.hash)) { location.reload(); return; }
    showTab(currentTab());
  });

  function goTab(name, filter) {
    if (filter) { T.filter = filter; renderMaisons(); }
    if (location.hash === `#${name}`) showTab(name); else location.hash = name;
  }

  // ---------------------------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------------------------

  function renderAll() {
    renderTop();
    renderAccueil();
    renderMaisons();
    renderCaisse();
    renderEquipe();
    drawMap();
    document.querySelector('.t-tabs a[data-tab="caisse"]').hidden = !(T.tr && T.tr.donsActive);
    if (T.tour.active) renderTour();
  }

  function renderTop() {
    const s = T.cur.sector;
    $("t-sector").innerHTML = `<b class="sector-code" style="background:${s.couleur}">${escapeHtml(s.code)}</b>
      <span>${escapeHtml(s.nom)}</span>${T.sectors.length > 1 ? `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>` : ""}`;
    $("t-sector").disabled = T.sectors.length < 2;
    const q = readQueue().length;
    $("t-sync").hidden = !q;
    $("t-sync").textContent = `⟳ ${q}`;
  }

  function ring(pct) {
    const r = 42;
    const c = 2 * Math.PI * r;
    return `<svg class="r-ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="${r}" class="r-ring-bg" />
      <circle cx="50" cy="50" r="${r}" class="r-ring-fg" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}" />
    </svg>`;
  }

  function renderAccueil() {
    const s = T.cur.sector;
    const tr = T.tr;
    const e = tr.equipe || s.equipe;
    const roleLabel = { admin: "Administrateur", responsable: "Responsable du secteur", equipier: "Équipier" }[tr.role] || "";
    const c = counts();
    const done = c.fait + c.absent + c.refus;
    const pct = c.total ? Math.round((done / c.total) * 100) : 0;
    const when = whenText(e);
    let html = `<div class="r-hello">
        <div><h2>Bonjour ${escapeHtml(firstName())} 👋</h2><p class="hint">${roleLabel} · ${escapeHtml(T.cur.communeNom)}</p></div>
        ${e ? statutPill(e.statut) : ""}
      </div>
      <div class="r-card r-when"><span class="r-when-date">${escapeHtml(when)}</span>
        ${e && e.note ? `<p class="r-note">${escapeHtml(e.note)}</p>` : ""}</div>`;

    if (tr.readOnly) {
      html += `<div class="r-card"><p class="hint">Le suivi des maisons n'est pas encore ouvert par le chef de tournée. Vous pouvez déjà consulter la carte et la liste des maisons.</p></div>`;
    } else {
      html += `<div class="r-card r-progress">
          <div class="r-ring-wrap">${ring(pct)}<span class="r-pct">${pct}<small>%</small></span></div>
          <div class="r-progress-text"><strong>${done} / ${c.total}</strong><span>maisons passées</span>
            <div class="r-chips">
              <button type="button" class="r-chip todo" data-filter="todo">${c.todo} à faire</button>
              <button type="button" class="r-chip fait" data-filter="fait">✓ ${c.fait}</button>
              <button type="button" class="r-chip absent" data-filter="absent">⏳ ${c.absent}</button>
              <button type="button" class="r-chip refus" data-filter="refus">✕ ${c.refus}</button>
            </div></div>
        </div>
        <button type="button" class="btn primary r-cta" data-action="tour">▶ ${c.todo === c.total ? "Commencer" : c.todo ? "Continuer" : "Revoir"} la tournée</button>
        ${c.absent ? `<button type="button" class="btn r-cta2" data-filter="absent">⏳ ${c.absent} absent${c.absent > 1 ? "s" : ""} à repasser</button>` : ""}`;

      if (tr.donsActive) {
        if (tr.full && tr.totaux) {
          const x = tr.totaux;
          html += `<div class="r-card r-money" data-goto="caisse">
            <span class="r-label">Dons du secteur</span><strong>${euros(x.total)}</strong>
            <small>${x.nb} don${x.nb > 1 ? "s" : ""} · espèces ${euros(x.especes)} · chèques ${euros(x.cheque)} · carte ${euros(x.cb)}</small>
            ${x.attente ? `<p class="total-wait">⏳ ${x.attente} paiement${x.attente > 1 ? "s" : ""} carte à confirmer</p>` : ""}
            ${tr.caisse ? `<p class="r-caisse">Caisse à remettre : <b>${euros(tr.caisse.reste.especes + tr.caisse.reste.cheques)}</b></p>` : ""}
          </div>`;
        } else {
          const mine = myDons().filter((d) => d.statut === "ok");
          html += `<div class="r-card r-money" data-goto="caisse"><span class="r-label">Mes dons</span>
            <strong>${euros(mine.reduce((n, d) => n + (d.montant || 0), 0))}</strong>
            <small>${mine.length} don${mine.length > 1 ? "s" : ""} enregistré${mine.length > 1 ? "s" : ""} par vous</small></div>`;
        }
      }
    }

    const prev = Object.values(tr.precedent || {});
    if (prev.length) {
      const pc = { fait: 0, absent: 0, refus: 0 };
      let nb = 0;
      let total = 0;
      for (const p of prev) {
        if (pc[p.status] !== undefined) pc[p.status]++;
        nb += p.nb_dons || 0;
        total += p.montant || 0;
      }
      html += `<div class="r-card r-prev"><span class="r-label">Tournée ${prev[0].annee}</span>
        <p>${plural(pc.fait, "faite")} · ${plural(pc.absent, "absent")} · ${pc.refus} refus${tr.full && nb ? ` · ${plural(nb, "don")}, ${euros(total)}` : ""}</p></div>`;
    }
    $("v-accueil").innerHTML = html;
  }

  const FILTERS = [
    ["todo", "À faire", (a) => !a.status],
    ["absent", "Absents", (a) => a.status === "absent"],
    ["fait", "Faits", (a) => a.status === "fait"],
    ["refus", "Refus", (a) => a.status === "refus"],
    ["all", "Toutes", () => true],
  ];

  function renderMaisons() {
    if (!T.cur) return;
    const addrs = T.cur.sector.addresses;
    const box = document.querySelector(".t-filters");
    box.innerHTML = FILTERS.map(([key, label, fn]) => `<button type="button" role="tab" class="t-filter${T.filter === key ? " active" : ""}" data-filter="${key}" aria-selected="${T.filter === key}">${label} <b>${addrs.filter(fn).length}</b></button>`).join("");
    const fn = FILTERS.find((f) => f[0] === T.filter)[2];
    const q = normalizeText(T.query).split(" ").filter(Boolean);
    const list = sortedAddresses().filter(fn).filter((a) => !q.length || q.every((t) => normalizeText(`${a.label} ${a.groupe}`).includes(t)));
    if (!list.length) {
      $("t-list").innerHTML = `<p class="empty">${T.filter === "todo" && !q.length ? "🎉 Toutes les maisons ont été passées !" : "Aucune maison ici."}</p>`;
      return;
    }
    let html = "";
    let group = null;
    for (const a of list) {
      if (a.groupe !== group) {
        group = a.groupe;
        html += `<h3 class="t-group">${escapeHtml(group)}</h3>`;
      }
      const btns = canEdit() ? `<div class="t-row-btns">
          ${Object.entries(STATUS).map(([k, v]) => `<button type="button" class="t-st ${k}${a.status === k ? " active" : ""}" data-status="${k}" aria-label="${v.label} : ${escapeHtml(a.label)}">${v.icon}</button>`).join("")}
          ${T.tr.donsActive ? `<button type="button" class="t-st don" data-don aria-label="Don : ${escapeHtml(a.label)}">€</button>` : ""}
        </div>` : "";
      html += `<div class="t-row${a.status ? ` st-${a.status}` : ""}" data-id="${escapeHtml(a.id)}">
        <button type="button" class="t-row-main" data-open><span class="t-row-label">${escapeHtml(a.label)}</span>
          <span class="t-row-chips">${prevChip(a)}${donBadges(a.id)}</span></button>
        ${btns}
      </div>`;
    }
    $("t-list").innerHTML = html;
  }

  function renderCaisse() {
    const tr = T.tr;
    const box = $("v-caisse");
    if (!tr || !tr.donsActive) { box.innerHTML = ""; return; }
    const label = (id) => escapeHtml((T.addr.get(id) || {}).label || id);
    const donLine = (d, editable) => `<div class="don-line" data-id="${d.id}">
        <span><b>${d.montant !== undefined ? euros(d.montant) : "Don"}</b> ${MODE_LABEL[d.mode]} ${d.statut === "ok" ? "✓" : d.statut === "attente" ? "⏳ en attente" : "✕ échoué"}
          <small>${label(d.address_id)} · ${escapeHtml(d.personne_nom)}${d.tx_code ? ` · ${escapeHtml(d.tx_code)}` : ""}</small></span>
        ${editable ? `<span class="don-line-actions">
          ${d.statut === "attente" ? `<button type="button" class="btn small" data-act="ok">Payé</button><button type="button" class="btn small" data-act="echec">Non payé</button>` : ""}
          <button type="button" class="icon-btn danger" data-act="delete" aria-label="Supprimer ce don">✕</button></span>` : ""}
      </div>`;
    let html = "";
    if (tr.full) {
      const x = tr.totaux || { total: 0, nb: 0, especes: 0, cheque: 0, cb: 0, attente: 0 };
      html += `<div class="r-card r-money"><span class="r-label">Total du secteur</span><strong>${euros(x.total)}</strong>
        <small>${x.nb} don${x.nb > 1 ? "s" : ""}</small>
        <div class="total-modes"><span>Espèces <b>${euros(x.especes)}</b></span><span>Chèques <b>${euros(x.cheque)}</b></span><span>Carte <b>${euros(x.cb)}</b></span></div></div>`;
      if (tr.caisse) {
        const c = tr.caisse;
        const r = c.reste;
        html += `<div class="r-card caisse-card">
          <span class="r-label">Caisse à remettre</span><strong>${euros(r.especes + r.cheques)}</strong>
          <small>${euros(r.especes)} en espèces · ${euros(r.cheques)} en chèques (${r.nb_cheques})</small>
          <button type="button" class="btn primary" data-action="caisse">Remettre la caisse</button>
          ${c.remises.length ? `<div class="remises-mini">${c.remises.map((x) => `<div><span>${new Date(x.created_at).toLocaleDateString("fr-FR")} · à ${escapeHtml(x.recu_par)}</span>
            <b>${euros(x.especes + x.cheques)}</b> ${x.confirme_le ? `<span class="confirmed">✓ reçu</span>` : `<span class="hint">à confirmer</span>`}</div>`).join("")}</div>` : ""}
        </div>`;
      }
      const pending = tr.allDons.filter((d) => d.statut === "attente");
      if (pending.length) html += `<h3 class="t-group">Paiements carte en attente</h3>${pending.map((d) => donLine(d, true)).join("")}`;
      const recent = [...tr.allDons].reverse();
      html += `<h3 class="t-group">Tous les dons (${recent.length})</h3>${recent.map((d) => donLine(d, true)).join("") || `<p class="hint">Aucun don pour l'instant.</p>`}`;
    } else {
      const mine = [...myDons()].reverse();
      const ok = mine.filter((d) => d.statut === "ok");
      html += `<div class="r-card r-money"><span class="r-label">Mes dons</span><strong>${euros(ok.reduce((n, d) => n + d.montant, 0))}</strong>
        <small>${ok.length} don${ok.length > 1 ? "s" : ""} · les totaux du secteur sont suivis par le responsable</small></div>
        <h3 class="t-group">Mes dons</h3>${mine.map((d) => donLine(d, true)).join("") || `<p class="hint">Aucun don enregistré par vous.</p>`}`;
    }
    box.innerHTML = html;
  }

  function renderEquipe() {
    const tr = T.tr;
    const s = T.cur.sector;
    const e = tr.equipe || s.equipe;
    const member = (p, role, removable) => `<div class="eq-member">
        ${personAvatar(p, "")}
        <span class="eq-who"><b>${escapeHtml(p.nom)}</b><small>${role}</small></span>
        ${removable ? `<button type="button" class="icon-btn eq-remove" data-remove="${p.id}" aria-label="Retirer ${escapeHtml(p.nom)} de l'équipe">✕</button>` : ""}
        ${p.telephone ? `<a class="icon-btn eq-call" href="${telHref(p.telephone)}" aria-label="Appeler ${escapeHtml(p.nom)}"><svg class="ico" viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2" /></svg></a>
          <a class="icon-btn eq-call" href="sms:${escapeHtml(p.telephone.replace(/[^0-9+]/g, ""))}" aria-label="SMS à ${escapeHtml(p.nom)}"><svg class="ico" viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4z" /></svg></a>` : ""}
      </div>`;
    const when = whenText(e);
    let html = `<div class="r-card"><span class="r-label">Secteur ${escapeHtml(s.code)}</span><strong class="eq-sector">${escapeHtml(s.nom)}</strong>
        <p class="r-when-date">${escapeHtml(when)}</p>${e && e.note ? `<p class="r-note">${escapeHtml(e.note)}</p>` : ""}</div>`;
    if (tr.lead && tr.equipe) {
      html += `<div class="r-card"><span class="r-label">Avancement du secteur</span>
        <div class="seg">${Object.entries(C.STATUT_LABEL).map(([k, v]) => `<button type="button" class="seg-btn${tr.equipe.statut === k ? " active" : ""}" data-avancement="${k}">${v}</button>`).join("")}</div></div>`;
    }
    if (e) {
      const canChange = tr.lead && tr.equipe === e;
      const people = [...e.responsables.map((p) => member(p, "Responsable", false)), ...e.equipiers.map((p) => member(p, "Équipier", canChange))];
      html += `<div class="r-card"><span class="r-label">L'équipe</span>${people.join("") || `<p class="hint">Équipe pas encore constituée.</p>`}
        ${canChange ? `<button type="button" class="btn eq-add" data-action="add-member">+ Ajouter un équipier</button>` : ""}</div>`;
    }
    html += `<div class="eq-links">
        <a class="btn" href="/plan.html#/${encodeURIComponent(T.cur.slug)}/${s.id}" target="_blank" rel="noopener">🖨 Plan du secteur à imprimer</a>
        <a class="btn" href="/#/${encodeURIComponent(T.cur.slug)}/${s.id}">🗺 Plan public (description des limites)</a>
        ${T.sectors.length > 1 ? `<button type="button" class="btn" data-action="sectors">Changer de secteur</button>` : ""}
        <button type="button" class="btn" data-action="logout">Se déconnecter</button>
      </div>
      <p class="hint eq-me">Connecté(e) : ${escapeHtml(T.me.personne ? T.me.personne.nom : "administrateur")} · ${escapeHtml(tourneeTitle(T.annee))}</p>`;
    $("v-equipe").innerHTML = html;
  }

  // ---------------------------------------------------------------------------------------
  // Carte
  // ---------------------------------------------------------------------------------------

  function statusColor(st) { return st ? STATUS[st].color : TODO_COLOR; }

  function ensureMap() {
    if (!T.map) {
      T.map = L.map("t-map", { zoomControl: true, zoomSnap: 0.5 }).setView([45.742, 4.57], 14);
      addBaseLayers(T.map);
      T.layer = L.layerGroup().addTo(T.map);
      const Locate = L.Control.extend({
        options: { position: "topleft" },
        onAdd() {
          const b = L.DomUtil.create("button", "locate-btn leaflet-bar");
          b.type = "button";
          b.setAttribute("aria-label", "Me localiser");
          b.innerHTML = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>`;
          L.DomEvent.disableClickPropagation(b);
          L.DomEvent.on(b, "click", () => { startGps(); if (T.myPos) T.map.setView(T.myPos, 17); b.classList.add("active"); });
          return b;
        },
      });
      T.map.addControl(new Locate());
      T.map.on("click", (e) => {
        const m = nearestMarker(e.latlng, 26);
        if (m) openFiche(T.addr.get(m.addressId));
      });
      drawMap();
    }
    setTimeout(() => {
      T.map.invalidateSize();
      if (!T.fitted && T.outline) { T.map.fitBounds(T.outline.getBounds(), { padding: [16, 16] }); T.fitted = true; }
    }, 60);
  }

  function drawMap() {
    if (!T.map || !T.cur) return;
    T.layer.clearLayers();
    T.markers.clear();
    const polys = toPolys(T.cur.sector.polygon);
    const mask = { stroke: false, fillColor: "#0f172a", fillOpacity: 0.3, interactive: false };
    L.polygon([WORLD, ...outerRings(polys)], mask).addTo(T.layer);
    holeRings(polys).forEach((h) => L.polygon(h, mask).addTo(T.layer));
    T.outline = L.polygon(polys, { color: T.cur.sector.couleur, weight: 4, fill: false, interactive: false }).addTo(T.layer);
    for (const a of T.cur.sector.addresses) {
      const m = L.circleMarker([a.lat, a.lon], { radius: 7, color: "#fff", weight: 2, fillColor: statusColor(a.status), fillOpacity: 1 });
      m.addressId = a.id;
      m.on("click", (e) => { L.DomEvent.stop(e); openFiche(a); });
      m.addTo(T.layer);
      T.markers.set(a.id, m);
    }
    if (T.myPos) drawMe();
    if (!T.fitted && !$("v-carte").hidden) { T.map.fitBounds(T.outline.getBounds(), { padding: [16, 16] }); T.fitted = true; }
  }

  function nearestMarker(latlng, maxPx) {
    const p = T.map.latLngToContainerPoint(latlng);
    let best = null;
    let bestD = maxPx;
    for (const m of T.markers.values()) {
      const d = p.distanceTo(T.map.latLngToContainerPoint(m.getLatLng()));
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  function startGps() {
    if (T.watch !== null || !navigator.geolocation) return;
    T.watch = navigator.geolocation.watchPosition((pos) => {
      T.myPos = [pos.coords.latitude, pos.coords.longitude];
      drawMe();
      // la maison proposée avant le premier point GPS est remplacée par la plus proche
      if (T.tour.active && T.tour.noGps) nextHouse();
      else if (T.tour.active) renderTourDistance();
    }, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
  }

  function drawMe() {
    if (!T.map || !T.myPos) return;
    if (!T.meMarker || !T.layer.hasLayer(T.meMarker)) {
      T.meMarker = L.circleMarker(T.myPos, { radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1, interactive: false }).addTo(T.layer);
    } else {
      T.meMarker.setLatLng(T.myPos);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Statuts : envoi, file hors réseau, annulation
  // ---------------------------------------------------------------------------------------

  function readQueue() { try { return JSON.parse(storage.get(QUEUE_KEY, "[]")); } catch { return []; } }
  function writeQueue(q) { storage.set(QUEUE_KEY, JSON.stringify(q)); }

  function sendStatus(slug, addressId, status) {
    return fetchJSON(`/api/communes/${slug}/addresses/${encodeURIComponent(addressId)}/status`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
    });
  }

  async function flushQueue() {
    const q = readQueue();
    if (!q.length) return;
    const remaining = [];
    for (const item of q) {
      try { await sendStatus(item.slug, item.addressId, item.status); } catch (err) {
        if (![401, 403, 404].includes(err.status)) remaining.push(item);
      }
    }
    writeQueue(remaining);
    if (T.cur) renderTop();
    if (!remaining.length) showToast("Modifications hors réseau envoyées ✓");
  }
  window.addEventListener("online", flushQueue);

  async function setStatus(a, status, { undo = true } = {}) {
    const prev = a.status || null;
    if (prev === status) return;
    a.status = status;
    refreshAfterChange(a);
    if (undo) {
      snack(`${a.label} : ${status ? STATUS[status].label.toLowerCase() : "à faire"}`, () => {
        setStatus(a, prev, { undo: false });
        if (T.tour.active) { T.tour.current = a; renderTour(); }
      });
    }
    try {
      await sendStatus(T.cur.slug, a.id, status);
    } catch (err) {
      if ([401, 403, 404].includes(err.status)) { showToast(err.message, true); return; }
      const q = readQueue().filter((x) => !(x.slug === T.cur.slug && x.addressId === a.id));
      q.push({ slug: T.cur.slug, addressId: a.id, status });
      writeQueue(q);
      renderTop();
      showToast("Pas de réseau : gardé sur le téléphone, envoyé au retour du réseau.");
    }
  }

  function refreshAfterChange(a) {
    T.markers.get(a.id)?.setStyle({ fillColor: statusColor(a.status) });
    renderAccueil();
    renderMaisons();
    if ($("t-fiche").open && ficheAddr === a) fillFiche(a);
  }

  let snackTimer = null;
  let snackUndo = null;
  function snack(text, undoFn) {
    $("t-snack-text").textContent = text;
    $("t-snack").hidden = false;
    $("t-snack-undo").hidden = !undoFn;
    snackUndo = undoFn;
    clearTimeout(snackTimer);
    snackTimer = setTimeout(() => { $("t-snack").hidden = true; snackUndo = null; }, 5000);
  }
  $("t-snack-undo").addEventListener("click", () => {
    const fn = snackUndo;
    $("t-snack").hidden = true;
    snackUndo = null;
    if (fn) fn();
  });

  // ---------------------------------------------------------------------------------------
  // Fiche d'une maison
  // ---------------------------------------------------------------------------------------

  let ficheAddr = null;

  function fillFiche(a) {
    $("tf-title").textContent = a.label;
    $("tf-sub").textContent = `${a.groupe} · ${T.cur.communeNom}`;
    $("tf-info").innerHTML = `${prevChip(a)}${donBadges(a.id)}`;
    document.querySelectorAll("#t-fiche .tf-status .tt-btn").forEach((b) => {
      b.classList.toggle("active", a.status === b.dataset.status);
      b.disabled = !canEdit();
    });
    document.querySelector("#t-fiche .tf-status").hidden = !canEdit();
    $("tf-don").hidden = !(T.tr && T.tr.donsActive);
    const nav = navLinks(a.lat, a.lon, a.label);
    $("tf-go").href = nav.main;
    if (nav.main.startsWith("geo:")) $("tf-go").removeAttribute("target"); else $("tf-go").target = "_blank";
  }

  function openFiche(a) {
    if (!a) return;
    ficheAddr = a;
    fillFiche(a);
    $("t-fiche").showModal();
  }

  document.querySelectorAll("#t-fiche .tf-status .tt-btn").forEach((b) => b.addEventListener("click", () => {
    const a = ficheAddr;
    setStatus(a, a.status === b.dataset.status ? null : b.dataset.status);
    $("t-fiche").close();
  }));
  $("tf-close").addEventListener("click", () => $("t-fiche").close());
  $("tf-don").addEventListener("click", () => { $("t-fiche").close(); openDon(ficheAddr); });

  // ---------------------------------------------------------------------------------------
  // Mode « maison suivante »
  // ---------------------------------------------------------------------------------------

  function startTour() {
    if (!canEdit()) { showToast("Le suivi n'est pas encore ouvert."); return; }
    T.tour.active = true;
    T.tour.skipped = new Set();
    T.tour.current = null;
    startGps();
    $("t-tournee").hidden = false;
    document.body.classList.add("t-touring");
    nextHouse();
  }

  function stopTour() {
    T.tour.active = false;
    $("t-tournee").hidden = true;
    document.body.classList.remove("t-touring");
    renderAll();
  }

  function whenText(e) {
    if (!e || !e.date) return "Date à définir";
    const d = formatDay(e.date, true);
    return `${d.charAt(0).toUpperCase()}${d.slice(1)}${e.creneau ? ` · ${e.creneau.toLowerCase()}` : ""}`;
  }

  /** La plus proche maison à faire : de ma position GPS, sinon de la dernière maison passée. */
  function nextHouse() {
    let todo = T.cur.sector.addresses.filter((a) => !a.status && !T.tour.skipped.has(a.id));
    if (!todo.length && T.tour.skipped.size) {
      T.tour.skipped.clear();
      todo = T.cur.sector.addresses.filter((a) => !a.status);
    }
    const ref = T.myPos || T.tour.last;
    T.tour.noGps = !T.myPos;
    if (!todo.length) T.tour.current = null;
    else if (ref) T.tour.current = todo.reduce((best, a) => (distanceM(ref, [a.lat, a.lon]) < distanceM(ref, [best.lat, best.lon]) ? a : best));
    else T.tour.current = sortedAddresses().find((a) => todo.includes(a));
    renderTour();
  }

  function renderTourDistance() {
    const a = T.tour.current;
    const el = document.querySelector("#tt-card .tt-dist");
    if (a && el && T.myPos) el.textContent = `à ${formatDistance(distanceM(T.myPos, [a.lat, a.lon]))}`;
  }

  function renderTour() {
    const c = counts();
    $("tt-progress").textContent = `${c.total - c.todo} / ${c.total} maisons · reste ${c.todo}`;
    const a = T.tour.current;
    const actions = document.querySelectorAll("#t-tournee .tt-actions");
    if (!a) {
      $("tt-card").innerHTML = `<div class="tt-done"><span>🎉</span><h2>Toutes les maisons sont passées !</h2>
        <p>${c.absent ? `${c.absent} absent${c.absent > 1 ? "s" : ""} à repasser plus tard (onglet Maisons).` : "Bravo à toute l'équipe."}</p></div>`;
      actions.forEach((x) => { x.hidden = true; });
      return;
    }
    actions.forEach((x) => { x.hidden = false; });
    $("tt-card").innerHTML = `<span class="tt-group">${escapeHtml(a.groupe)}</span>
      <h2 class="tt-label">${escapeHtml(a.label)}</h2>
      <span class="tt-dist"></span>
      <div class="tt-chips">${prevChip(a)}${donBadges(a.id)}</div>`;
    renderTourDistance();
    $("tt-don").hidden = !(T.tr && T.tr.donsActive);
    const nav = navLinks(a.lat, a.lon, a.label);
    $("tt-go").href = nav.main;
    if (nav.main.startsWith("geo:")) $("tt-go").removeAttribute("target"); else $("tt-go").target = "_blank";
  }

  document.querySelectorAll("#t-tournee .tt-actions:not(.secondary) .tt-btn").forEach((b) => b.addEventListener("click", () => {
    const a = T.tour.current;
    if (!a) return;
    T.tour.last = [a.lat, a.lon];
    setStatus(a, b.dataset.status);
    nextHouse();
  }));
  $("tt-skip").addEventListener("click", () => {
    if (!T.tour.current) return;
    T.tour.skipped.add(T.tour.current.id);
    T.tour.last = [T.tour.current.lat, T.tour.current.lon];
    nextHouse();
  });
  $("tt-don").addEventListener("click", () => { if (T.tour.current) openDon(T.tour.current); });
  $("tt-quit").addEventListener("click", stopTour);

  // ---------------------------------------------------------------------------------------
  // Dons (avec SumUp)
  // ---------------------------------------------------------------------------------------

  const donDialog = $("don-dialog");
  let donCtx = null;

  function sumupReady() { return !!(T.me && T.me.sumup && T.me.sumup.affiliate_key); }
  function selectedMode() { return donDialog.querySelector('input[name="mode"]:checked').value; }

  function refreshDonDialog() {
    const cb = selectedMode() === "cb";
    const sumup = cb && sumupReady();
    const manual = donCtx.manual || (cb && !sumupReady());
    $("don-sumup").hidden = !sumup || donCtx.manual;
    $("don-save").hidden = sumup && !donCtx.manual;
    $("don-manual-toggle").hidden = !sumup || donCtx.manual;
    $("don-cb-manual").hidden = !(cb && manual);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    $("don-ios-hint").hidden = !(sumup && !donCtx.manual && IS_IOS && standalone);
  }

  function renderExistingDons() {
    const list = T.tr.dons.get(donCtx.a.id) || [];
    $("don-existing").innerHTML = list.map((d) => `<div class="don-line" data-id="${d.id}">
        <span><b>${d.montant !== undefined ? euros(d.montant) : "Don"}</b> ${MODE_LABEL[d.mode]} ${d.statut === "ok" ? "✓" : d.statut === "attente" ? "⏳ en attente" : "✕ échoué"}<small>${escapeHtml(d.personne_nom)}</small></span>
        ${T.tr.full || d.mine ? `<span class="don-line-actions">${d.statut === "attente" ? `<button type="button" class="btn small" data-act="ok">Payé</button><button type="button" class="btn small" data-act="echec">Non payé</button>` : ""}
          <button type="button" class="icon-btn danger" data-act="delete" aria-label="Supprimer ce don">✕</button></span>` : ""}
      </div>`).join("");
  }

  function openDon(a) {
    donCtx = { a, manual: false };
    $("don-address").textContent = a.label;
    $("don-montant").value = "";
    $("don-tx").value = "";
    $("don-error").hidden = true;
    donDialog.querySelector('input[name="mode"][value="especes"]').checked = true;
    renderExistingDons();
    refreshDonDialog();
    donDialog.showModal();
  }

  donDialog.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", refreshDonDialog));
  donDialog.querySelector(".amount-chips").addEventListener("click", (e) => { if (e.target.dataset.amount) $("don-montant").value = e.target.dataset.amount; });
  $("don-manual-toggle").addEventListener("click", () => { donCtx.manual = true; refreshDonDialog(); });

  function readAmount() {
    const v = parseEuros($("don-montant").value);
    if (!(v > 0 && v <= 1000)) throw new Error("Indiquez un montant (entre 0 et 1000 €).");
    return Math.round(v * 100) / 100;
  }

  function postDon(sumup) {
    return fetchJSON("/api/equipe/dons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: T.cur.slug, address_id: donCtx.a.id, montant: readAmount(), mode: selectedMode(), sumup, tx_code: $("don-tx").value }),
    });
  }

  function donError(err) {
    $("don-error").textContent = err.message;
    $("don-error").hidden = false;
  }

  async function afterDon(a) {
    await reload();
    if (T.tour.active && T.tour.current === a) { T.tour.last = [a.lat, a.lon]; nextHouse(); }
  }

  $("don-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const don = await postDon(false);
      const a = donCtx.a;
      donDialog.close();
      snack(`Don de ${euros(don.montant)} enregistré`, async () => {
        await fetchJSON(`/api/equipe/dons/${don.id}`, { method: "DELETE" }).catch((err) => showToast(err.message, true));
        await reload();
      });
      await afterDon(a);
    } catch (err) {
      donError(err);
    }
  });

  function openExternal(url) {
    if (typeof window.__openExternal === "function") window.__openExternal(url);
    else location.href = url;
  }

  /** Ouvre l'appli SumUp avec le montant ; elle revient sur /sumup-retour/<id> une fois payé. */
  function sumupUrl(cfg, don) {
    const amount = don.montant.toFixed(2);
    const back = `${location.origin}/sumup-retour/${don.foreign_id}`;
    const params = {
      "affiliate-key": cfg.affiliate_key, total: amount, amount, currency: "EUR",
      title: `Calendrier ${T.annee || ""}`.trim(), "foreign-tx-id": don.foreign_id,
      callback: back, callbacksuccess: back, callbackfail: back,
    };
    if (cfg.app_id) params["app-id"] = cfg.app_id;
    return `sumupmerchant://pay/1.0?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
  }

  $("don-sumup").addEventListener("click", async () => {
    try {
      const don = await postDon(true);
      donDialog.close();
      showToast("Ouverture de SumUp…");
      openExternal(sumupUrl(T.me.sumup, don));
      setTimeout(() => reload(), 2500);
    } catch (err) {
      donError(err);
    }
  });

  async function donAction(id, act) {
    if (act === "delete") {
      if (!confirm("Supprimer ce don ?")) return;
      await fetchJSON(`/api/equipe/dons/${id}`, { method: "DELETE" });
    } else {
      const tx = act === "ok" ? (prompt("N° de transaction SumUp (facultatif) :") || "") : "";
      await fetchJSON(`/api/equipe/dons/${id}/statut`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ statut: act, tx_code: tx }),
      });
    }
    await reload();
  }

  $("don-existing").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    try {
      await donAction(btn.closest(".don-line").dataset.id, btn.dataset.act);
      renderExistingDons();
    } catch (err) { donError(err); }
  });

  // ---------------------------------------------------------------------------------------
  // Caisse
  // ---------------------------------------------------------------------------------------

  const caisseDialog = $("caisse-dialog");
  const numFr = (v) => String(Math.round(v * 100) / 100).replace(".", ",");

  function openCaisse() {
    const r = T.tr.caisse.reste;
    $("caisse-attendu").textContent = `D'après les dons saisis, il reste à remettre ${euros(r.especes)} en espèces et ${euros(r.cheques)} en chèques (${r.nb_cheques}). Comptez et corrigez si besoin.`;
    $("caisse-especes").value = numFr(Math.max(0, r.especes));
    $("caisse-cheques").value = numFr(Math.max(0, r.cheques));
    $("caisse-nb").value = Math.max(0, r.nb_cheques);
    $("caisse-recu").value = storage.get("caisse-recu-par", "");
    $("caisse-note").value = "";
    $("caisse-error").hidden = true;
    updateEcart();
    caisseDialog.showModal();
  }

  function updateEcart() {
    const r = T.tr.caisse.reste;
    const de = parseEuros($("caisse-especes").value) - r.especes;
    const dc = parseEuros($("caisse-cheques").value) - r.cheques;
    const parts = [];
    if (Math.abs(de) >= 0.005) parts.push(`espèces ${de > 0 ? "+" : ""}${euros(de)}`);
    if (Math.abs(dc) >= 0.005) parts.push(`chèques ${dc > 0 ? "+" : ""}${euros(dc)}`);
    $("caisse-ecart").hidden = !parts.length;
    $("caisse-ecart").textContent = parts.length ? `Écart avec les dons saisis : ${parts.join(" · ")}. Ajoutez une remarque pour l'expliquer.` : "";
  }
  ["caisse-especes", "caisse-cheques"].forEach((id) => $(id).addEventListener("input", updateEcart));

  $("caisse-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const recu = $("caisse-recu").value.trim();
    try {
      await fetchJSON(`/api/equipe/secteurs/${T.cur.sector.id}/remises`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          especes: parseEuros($("caisse-especes").value), cheques: parseEuros($("caisse-cheques").value),
          nb_cheques: Number($("caisse-nb").value) || 0, recu_par: recu, note: $("caisse-note").value,
        }),
      });
      storage.set("caisse-recu-par", recu);
      caisseDialog.close();
      showToast("Remise enregistrée ✓ Le trésorier la confirmera.");
      await reload();
    } catch (err) {
      $("caisse-error").textContent = err.status === 422 ? "Vérifiez les montants et le nom de la personne." : err.message;
      $("caisse-error").hidden = false;
    }
  });

  // ---------------------------------------------------------------------------------------
  // Équipe : le responsable ajoute un remplaçant ou retire un absent
  // ---------------------------------------------------------------------------------------

  const addDialog = $("t-add");
  let addPeople = [];

  function teamChanged(eq, message) {
    T.tr.equipe = eq;
    renderEquipe();
    renderAccueil();
    showToast(message);
  }

  function renderAddList() {
    const q = normalizeText($("ta-search").value).split(" ").filter(Boolean);
    const list = addPeople.filter((p) => q.every((t) => normalizeText(p.nom).includes(t)));
    $("ta-list").innerHTML = list.map((p) => {
      const where = p.ailleurs.map((x) => {
        const sec = T.allSectors.get(x.sector_id);
        return sec ? `${x.meme_jour ? "⚠ " : ""}${escapeHtml(sec.code)}${x.meme_jour ? " le même jour" : ""}` : "";
      }).filter(Boolean);
      const busy = p.ailleurs.some((x) => x.meme_jour);
      return `<button type="button" class="ta-item${busy ? " busy" : ""}" data-id="${p.id}">
          ${personAvatar(p, "")}<span class="ta-who"><b>${escapeHtml(p.nom)}</b>${where.length ? `<small>Déjà prévu : ${where.join(", ")}</small>` : `<small>Libre</small>`}</span>
          <span class="ta-plus">+</span></button>`;
    }).join("") || `<p class="hint">${addPeople.length ? "Personne à ce nom." : "Tout le monde est déjà dans l'équipe."}</p>`;
  }

  async function openAddMember() {
    $("ta-error").hidden = true;
    $("ta-search").value = "";
    $("ta-nom").value = "";
    $("ta-tel").value = "";
    $("ta-new").open = false;
    $("ta-list").innerHTML = `<p class="hint">Chargement…</p>`;
    addDialog.showModal();
    document.activeElement?.blur(); // pas de clavier qui cache la liste à l'ouverture
    try {
      addPeople = (await fetchJSON(`/api/equipe/secteurs/${T.cur.sector.id}/personnes`)).personnes;
      renderAddList();
    } catch (err) { addError(err); }
  }

  function addError(err) {
    $("ta-error").textContent = err.message;
    $("ta-error").hidden = false;
  }

  async function addMember(body, nom) {
    try {
      const eq = await fetchJSON(`/api/equipe/secteurs/${T.cur.sector.id}/equipiers`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      addDialog.close();
      teamChanged(eq, `${nom} ajouté(e) à l'équipe ✓`);
    } catch (err) { addError(err); }
  }

  $("ta-search").addEventListener("input", renderAddList);
  // Entrée ne ferme pas la fenêtre (formulaire « dialog ») ; dans le nom, elle ajoute la personne
  ["ta-search", "ta-nom", "ta-tel"].forEach((id) => $(id).addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (id !== "ta-search") $("ta-create").click();
  }));
  $("ta-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-id]");
    if (!b) return;
    const p = addPeople.find((x) => x.id === Number(b.dataset.id));
    const same = p.ailleurs.filter((x) => x.meme_jour).map((x) => (T.allSectors.get(x.sector_id) || {}).code).filter(Boolean);
    if (same.length && !confirm(`${p.nom} est déjà prévu(e) sur ${same.join(", ")} le même jour. L'ajouter quand même ?`)) return;
    addMember({ personne_id: p.id }, p.nom);
  });
  $("ta-create").addEventListener("click", () => {
    const nom = $("ta-nom").value.trim();
    if (!nom) { addError(new Error("Indiquez le nom de la personne.")); $("ta-nom").focus(); return; }
    addMember({ personne: { nom, telephone: $("ta-tel").value.trim() } }, nom);
  });

  async function removeMember(id) {
    const p = T.tr.equipe.equipiers.find((x) => x.id === id);
    if (!p || !confirm(`Retirer ${p.nom} de l'équipe ? ${p.nom.split(" ")[0]} n'aura plus accès à ce secteur.`)) return;
    try {
      const eq = await fetchJSON(`/api/equipe/secteurs/${T.cur.sector.id}/equipiers/${id}`, { method: "DELETE" });
      teamChanged(eq, `${p.nom} retiré(e) de l'équipe`);
    } catch (err) { showToast(err.message, true); }
  }

  // ---------------------------------------------------------------------------------------
  // Choix du secteur, déconnexion
  // ---------------------------------------------------------------------------------------

  function openSectors() {
    $("ts-list").innerHTML = T.sectors.map((x) => `<button type="button" class="ts-item${x === T.cur ? " active" : ""}" data-id="${x.sector.id}">
        <b class="sector-code" style="background:${x.sector.couleur}">${escapeHtml(x.sector.code)}</b>
        <span><b>${escapeHtml(x.sector.nom)}</b><small>${escapeHtml(x.communeNom)}${x.role === "responsable" ? " · responsable" : ""}</small></span></button>`).join("");
    $("t-sectors").showModal();
  }
  $("t-sector").addEventListener("click", () => { if (T.sectors.length > 1) openSectors(); });
  $("ts-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-id]");
    if (!b) return;
    $("t-sectors").close();
    const item = T.sectors.find((x) => x.sector.id === Number(b.dataset.id));
    if (item && item !== T.cur) await selectSector(item);
  });

  async function logout() {
    await fetchJSON("/api/equipe/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
  }

  // ---------------------------------------------------------------------------------------
  // Évènements des vues
  // ---------------------------------------------------------------------------------------

  document.body.addEventListener("click", async (e) => {
    const filter = e.target.closest("[data-filter]");
    if (filter && !filter.classList.contains("t-filter")) { goTab("maisons", filter.dataset.filter); return; }
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "tour") startTour();
    if (action === "caisse") openCaisse();
    if (action === "sectors") openSectors();
    if (action === "logout") logout();
    if (action === "add-member") openAddMember();
    const rm = e.target.closest("[data-remove]");
    if (rm) { removeMember(Number(rm.dataset.remove)); return; }
    const gotoTab = e.target.closest("[data-goto]");
    if (gotoTab) goTab(gotoTab.dataset.goto);
    const av = e.target.closest("[data-avancement]");
    if (av) {
      try {
        const eq = await fetchJSON(`/api/equipe/secteurs/${T.cur.sector.id}/avancement`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ statut: av.dataset.avancement }),
        });
        T.tr.equipe = eq;
        renderEquipe();
        renderAccueil();
        showToast(`Secteur : ${C.STATUT_LABEL[eq.statut].toLowerCase()}`);
      } catch (err) { showToast(err.message, true); }
    }
  });

  document.querySelector(".t-filters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    T.filter = b.dataset.filter;
    renderMaisons();
  });
  $("t-search").addEventListener("input", () => { T.query = $("t-search").value; renderMaisons(); });

  $("t-list").addEventListener("click", (e) => {
    const row = e.target.closest(".t-row");
    if (!row) return;
    const a = T.addr.get(row.dataset.id);
    const st = e.target.closest("[data-status]");
    if (st) { setStatus(a, a.status === st.dataset.status ? null : st.dataset.status); return; }
    if (e.target.closest("[data-don]")) { openDon(a); return; }
    if (e.target.closest("[data-open]")) openFiche(a);
  });

  $("v-caisse").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    try { await donAction(btn.closest(".don-line").dataset.id, btn.dataset.act); } catch (err) { showToast(err.message, true); }
  });

  document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

  // actualisation : retour sur l'appli (après SumUp) et chaque minute
  function autoRefresh() {
    if (document.visibilityState !== "visible" || !T.cur || document.querySelector("dialog[open]")) return;
    if (readQueue().length) { flushQueue(); return; }
    reload();
  }
  document.addEventListener("visibilitychange", autoRefresh);
  setInterval(autoRefresh, 60000);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }

  // ---------------------------------------------------------------------------------------
  // Démarrage (lien personnel « /equipe#acces=CODE » accepté)
  // ---------------------------------------------------------------------------------------

  (async () => {
    const m = /[#&]acces=([A-Za-z0-9-]+)/.exec(location.hash);
    if (m) {
      history.replaceState(null, "", "/equipe#accueil");
      try { await login(m[1]); } catch (err) { showLogin(`Lien d'accès refusé : ${err.message}`); return; }
    }
    try {
      await start();
    } catch (err) {
      console.error(err);
      showToast(`Erreur de chargement : ${err.message}`, true);
    }
  })();
})();
