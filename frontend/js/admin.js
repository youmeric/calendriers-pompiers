(() => {
  "use strict";
  const { PALETTE, escapeHtml, fetchJSON, showToast, pointInPolygon, osmLayer, labelPoint } = window.Common;

  const SNAP_DISTANCE = 20;
  const OUTSIDE_COLOR = "#111111";

  const els = {
    loginView: document.getElementById("login-view"),
    loginForm: document.getElementById("login-form"),
    password: document.getElementById("password"),
    loginError: document.getElementById("login-error"),
    editorView: document.getElementById("editor-view"),
    select: document.getElementById("commune-select"),
    logout: document.getElementById("btn-logout"),
    draw: document.getElementById("btn-draw"),
    save: document.getElementById("btn-save"),
    dirtyHint: document.getElementById("dirty-hint"),
    snap: document.getElementById("snap-toggle"),
    roads: document.getElementById("roads-toggle"),
    buildings: document.getElementById("buildings-toggle"),
    warnings: document.getElementById("warnings"),
    list: document.getElementById("sector-editor-list"),
    importAuto: document.getElementById("btn-import-auto"),
    resetStatus: document.getElementById("btn-reset-status"),
  };

  const state = {
    map: null,
    canvas: null,
    slug: null,
    data: null,
    sectors: [], // {id, nom, couleur, layer, label, count, groups}
    markers: [],
    roadsLayer: null,
    buildingsLayer: null,
    contourLayer: null,
    editing: null,
    selected: null,
    dirty: false,
  };

  // ---- Connexion ------------------------------------------------------------------

  function showLogin() {
    els.loginView.hidden = false;
    els.editorView.hidden = true;
    els.select.hidden = true;
    els.logout.hidden = true;
    els.password.focus();
  }

  function showEditor() {
    els.loginView.hidden = true;
    els.editorView.hidden = false;
    els.select.hidden = false;
    els.logout.hidden = false;
    if (state.map) setTimeout(() => state.map.invalidateSize(), 50);
  }

  els.loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.loginError.hidden = true;
    try {
      await fetchJSON("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: els.password.value }),
      });
    } catch (err) {
      els.loginError.textContent = err.message;
      els.loginError.hidden = false;
      return;
    }
    els.password.value = "";
    if (state.data) {
      showEditor();
      showToast("Reconnecté : vous pouvez enregistrer.");
    } else {
      await start().catch((err) => showToast(`Erreur de chargement : ${err.message}`, true));
    }
  });

  els.logout.addEventListener("click", async () => {
    if (state.dirty && !confirm("Des modifications ne sont pas enregistrées. Se déconnecter quand même ?")) return;
    await fetchJSON("/api/admin/logout", { method: "POST" }).catch(() => {});
    state.dirty = false;
    location.reload();
  });

  // ---- Carte ------------------------------------------------------------------------

  function initMap() {
    // une vue initiale est indispensable avant d'ajouter des calques (rendu canvas)
    state.map = L.map("admin-map", { zoomControl: true }).setView([45.742, 4.57], 13);
    osmLayer().addTo(state.map);
    state.canvas = L.canvas({ padding: 0.5 });
    state.map.pm.setLang("fr");
    state.map.pm.setGlobalOptions({ snappable: true, snapDistance: SNAP_DISTANCE, allowSelfIntersection: false });

    state.map.on("pm:drawstart", () => { els.draw.textContent = "✖ Annuler le dessin"; els.draw.classList.add("active"); });
    state.map.on("pm:drawend", () => { els.draw.textContent = "✏️ Dessiner un secteur"; els.draw.classList.remove("active"); });
    state.map.on("pm:create", (e) => {
      const ring = ringOf(e.layer);
      state.map.removeLayer(e.layer);
      const sector = addSector({ id: null, nom: `Secteur ${state.sectors.length + 1}`, couleur: nextColor(), polygon: ring });
      markDirty();
      recompute();
      renderList();
      selectSector(sector, true);
    });
  }

  function clearCommuneLayers() {
    if (state.editing) stopEditing();
    state.map.pm.disableDraw();
    for (const s of state.sectors) { state.map.removeLayer(s.layer); state.map.removeLayer(s.label); }
    state.sectors = [];
    for (const layer of [state.roadsLayer, state.buildingsLayer, state.contourLayer]) {
      if (layer) state.map.removeLayer(layer);
    }
    state.markers.forEach((m) => state.map.removeLayer(m));
    state.markers = [];
    state.selected = null;
  }

  function buildBaseLayers(data) {
    state.contourLayer = data.commune.contour
      ? L.geoJSON(data.commune.contour, {
        style: { color: "#222", weight: 2, dashArray: "6 6", fill: false },
        interactive: false, pmIgnore: true, snapIgnore: false,
      }).addTo(state.map)
      : null;

    state.roadsLayer = L.layerGroup(data.roads.map((r) => L.polyline(r.points, {
      renderer: state.canvas, color: "#3b4252", weight: 3, opacity: 0.35,
      interactive: false, pmIgnore: true, snapIgnore: false,
    })));
    if (els.roads.checked) state.roadsLayer.addTo(state.map);

    state.buildingsLayer = L.layerGroup(data.buildings.map((b) => L.polygon(b, {
      renderer: state.canvas, color: "#8a5a2b", weight: 1, fillOpacity: 0.35,
      interactive: false, pmIgnore: true, snapIgnore: true,
    })));
    if (els.buildings.checked) state.buildingsLayer.addTo(state.map);

    state.markers = data.addresses.map((a) => L.circleMarker([a.lat, a.lon], {
      renderer: state.canvas, radius: 4, weight: 1, color: "#fff", fillColor: OUTSIDE_COLOR, fillOpacity: 1,
      pmIgnore: true, snapIgnore: true,
    }).bindTooltip(`${escapeHtml(a.label)}<br><small>${escapeHtml(a.groupe)}</small>`).addTo(state.map));
  }

  function ringOf(layer) {
    let latlngs = layer.getLatLngs();
    while (Array.isArray(latlngs[0])) latlngs = latlngs[0];
    return latlngs.map((ll) => [+ll.lat.toFixed(6), +ll.lng.toFixed(6)]);
  }

  function nextColor() {
    const used = new Set(state.sectors.map((s) => s.couleur.toLowerCase()));
    return PALETTE.find((c) => !used.has(c)) || PALETTE[state.sectors.length % PALETTE.length];
  }

  function sectorStyle(sector) {
    const selected = state.selected === sector;
    return { color: sector.couleur, fillColor: sector.couleur, weight: selected ? 4 : 2, fillOpacity: selected ? 0.25 : 0.15 };
  }

  function labelIcon(sector) {
    return L.divIcon({
      className: "sector-label-icon",
      html: `<span style="border-color:${sector.couleur}">${escapeHtml(sector.nom)}</span>`,
      iconSize: null,
    });
  }

  function addSector({ id, nom, couleur, polygon }) {
    const sector = { id, nom, couleur, count: 0, groups: 0 };
    sector.layer = L.polygon(polygon, {}).addTo(state.map);
    sector.layer.setStyle(sectorStyle(sector));
    sector.label = L.marker(L.latLngBounds(polygon).getCenter(), {
      icon: labelIcon(sector), interactive: false, keyboard: false, pmIgnore: true, snapIgnore: true,
    }).addTo(state.map);
    sector.layer.on("click", () => { if (!state.map.pm.globalDrawModeEnabled()) selectSector(sector, true); });
    sector.layer.on("pm:edit", () => { markDirty(); recompute(); });
    state.sectors.push(sector);
    return sector;
  }

  function removeSector(sector) {
    if (state.editing === sector) stopEditing();
    state.map.removeLayer(sector.layer);
    state.map.removeLayer(sector.label);
    state.sectors = state.sectors.filter((s) => s !== sector);
    if (state.selected === sector) state.selected = null;
    markDirty();
    recompute();
    renderList();
  }

  function selectSector(sector, scroll) {
    const previous = state.selected;
    state.selected = sector;
    if (previous) previous.layer.setStyle(sectorStyle(previous));
    sector.layer.setStyle(sectorStyle(sector));
    document.querySelectorAll(".sector-edit-card").forEach((card) => {
      card.classList.toggle("selected", card.dataset.index === String(state.sectors.indexOf(sector)));
    });
    if (scroll) {
      const card = document.querySelector(`.sector-edit-card[data-index="${state.sectors.indexOf(sector)}"]`);
      if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function startEditing(sector) {
    if (state.editing && state.editing !== sector) stopEditing();
    state.map.pm.disableDraw();
    state.editing = sector;
    sector.layer.pm.enable({ snappable: els.snap.checked, snapDistance: SNAP_DISTANCE, allowSelfIntersection: false });
    selectSector(sector, false);
    state.map.fitBounds(sector.layer.getBounds(), { padding: [30, 30] });
    renderList();
  }

  function stopEditing() {
    if (!state.editing) return;
    state.editing.layer.pm.disable();
    state.editing = null;
    renderList();
  }

  // ---- Affectation des adresses et alertes -----------------------------------------

  function recompute() {
    const rings = state.sectors.map((s) => ringOf(s.layer));
    const addresses = state.data.addresses;
    const owners = addresses.map((a) => rings.reduce((acc, ring, i) => {
      if (pointInPolygon(a.lat, a.lon, ring)) acc.push(i);
      return acc;
    }, []));

    state.sectors.forEach((s) => { s.count = 0; s.groupSet = new Set(); });
    const outside = [];
    const overlap = [];
    const groupOwners = new Map();

    owners.forEach((own, idx) => {
      const a = addresses[idx];
      const first = own.length ? own[0] : null;
      if (first === null) outside.push(a);
      else {
        state.sectors[first].count++;
        state.sectors[first].groupSet.add(a.groupe_id);
      }
      if (own.length > 1) overlap.push({ a, own });
      if (!groupOwners.has(a.groupe_id)) groupOwners.set(a.groupe_id, { nom: a.groupe, owners: new Set(), addrs: [] });
      const g = groupOwners.get(a.groupe_id);
      g.owners.add(first);
      g.addrs.push(a);
      state.markers[idx].setStyle({
        fillColor: first === null ? OUTSIDE_COLOR : state.sectors[first].couleur,
        color: own.length > 1 ? "#ff00ff" : "#fff",
        weight: own.length > 1 ? 2 : 1,
      });
    });

    state.sectors.forEach((s, i) => {
      s.groups = s.groupSet.size;
      const mine = addresses.filter((_, idx) => owners[idx][0] === i);
      s.label.setLatLng(labelPoint({ polygon: rings[i] }, mine));
    });

    const cutGroups = [...groupOwners.values()].filter((g) => g.owners.size > 1);
    renderWarnings({ outside, overlap, cutGroups });
    updateCounts();
  }

  function sectorName(index) {
    return index === null ? "hors secteur" : `« ${state.sectors[index].nom} »`;
  }

  function renderWarnings({ outside, overlap, cutGroups }) {
    const items = [];
    if (!state.sectors.length) {
      els.warnings.innerHTML = `<div class="warning info">Aucun secteur pour l'instant : dessinez-en un, ou importez la proposition automatique (« Autres outils » en bas).</div>`;
      return;
    }
    cutGroups.forEach((g) => {
      const names = [...g.owners].map(sectorName).join(" et ");
      items.push({ cls: "danger", text: `Hameau « ${escapeHtml(g.nom)} » coupé entre ${escapeHtml(names)} (${g.addrs.length} adresses).`, addrs: g.addrs });
    });
    if (outside.length) {
      const byGroup = {};
      outside.forEach((a) => { byGroup[a.groupe] = (byGroup[a.groupe] || 0) + 1; });
      const top = Object.entries(byGroup).sort((x, y) => y[1] - x[1]).slice(0, 4)
        .map(([n, c]) => `${escapeHtml(n)} (${c})`).join(", ");
      items.push({ cls: "warn", text: `${outside.length} adresse(s) dans aucun secteur : ${top}${Object.keys(byGroup).length > 4 ? "…" : ""}`, addrs: outside });
    }
    if (overlap.length) {
      const pairs = new Set(overlap.map((o) => o.own.map((i) => state.sectors[i].nom).join(" / ")));
      items.push({ cls: "warn", text: `${overlap.length} adresse(s) dans plusieurs secteurs à la fois (chevauchement : ${escapeHtml([...pairs].join(", "))}). Elles sont comptées dans le premier de la liste.`, addrs: overlap.map((o) => o.a) });
    }
    if (!items.length) {
      els.warnings.innerHTML = `<div class="warning ok">✓ Toutes les adresses sont dans un secteur, aucun hameau coupé, aucun chevauchement.</div>`;
      return;
    }
    els.warnings.innerHTML = "";
    items.forEach((item) => {
      const div = document.createElement("div");
      div.className = `warning ${item.cls}`;
      div.innerHTML = `<span>${item.text}</span>`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn small";
      btn.textContent = "Voir";
      btn.addEventListener("click", () => {
        state.map.fitBounds(L.latLngBounds(item.addrs.map((a) => [a.lat, a.lon])), { padding: [60, 60], maxZoom: 17 });
      });
      div.appendChild(btn);
      els.warnings.appendChild(div);
    });
  }

  // ---- Liste des secteurs ----------------------------------------------------------

  function renderList() {
    els.list.innerHTML = "";
    state.sectors.forEach((sector, index) => {
      const card = document.createElement("div");
      card.className = "sector-edit-card";
      card.dataset.index = String(index);
      card.classList.toggle("selected", state.selected === sector);
      card.style.borderLeftColor = sector.couleur;

      const row = document.createElement("div");
      row.className = "sector-edit-row";

      const color = document.createElement("input");
      color.type = "color";
      color.value = sector.couleur;
      color.title = "Couleur du secteur";
      color.addEventListener("input", () => {
        sector.couleur = color.value;
        card.style.borderLeftColor = color.value;
        sector.layer.setStyle(sectorStyle(sector));
        sector.label.setIcon(labelIcon(sector));
        markDirty();
        recompute();
      });

      const name = document.createElement("input");
      name.type = "text";
      name.value = sector.nom;
      name.maxLength = 80;
      name.placeholder = "Nom du secteur";
      name.setAttribute("aria-label", "Nom du secteur");
      name.addEventListener("input", () => {
        sector.nom = name.value;
        sector.label.setIcon(labelIcon(sector));
        markDirty();
      });
      name.addEventListener("focus", () => selectSector(sector, false));

      row.append(color, name);

      const meta = document.createElement("div");
      meta.className = "sector-edit-meta";
      meta.dataset.role = "count";
      meta.textContent = countText(sector);

      const actions = document.createElement("div");
      actions.className = "sector-edit-actions";
      const editing = state.editing === sector;
      actions.append(
        button(editing ? "✓ Terminer" : "Modifier le tracé", editing ? "btn small primary" : "btn small", () => {
          if (editing) stopEditing(); else startEditing(sector);
        }),
        button("Centrer", "btn small", () => {
          selectSector(sector, false);
          state.map.fitBounds(sector.layer.getBounds(), { padding: [30, 30] });
        }),
        button("Supprimer", "btn small danger", () => {
          if (confirm(`Supprimer le secteur « ${sector.nom} » ?`)) removeSector(sector);
        }),
      );

      card.append(row, meta, actions);
      els.list.appendChild(card);
    });
  }

  function countText(sector) {
    return `${sector.count} adresse(s) · ${sector.groups} groupe(s) d'habitations`;
  }

  function updateCounts() {
    document.querySelectorAll(".sector-edit-card").forEach((card) => {
      const sector = state.sectors[Number(card.dataset.index)];
      if (sector) card.querySelector('[data-role="count"]').textContent = countText(sector);
    });
  }

  function button(text, cls, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  // ---- Enregistrement --------------------------------------------------------------

  function markDirty() {
    state.dirty = true;
    els.save.disabled = false;
    els.dirtyHint.hidden = false;
  }

  function markClean() {
    state.dirty = false;
    els.save.disabled = true;
    els.dirtyHint.hidden = true;
  }

  async function save() {
    const empty = state.sectors.find((s) => !s.nom.trim());
    if (empty) {
      showToast("Chaque secteur doit avoir un nom.", true);
      selectSector(empty, true);
      return;
    }
    const payload = {
      sectors: state.sectors.map((s) => ({ id: s.id, nom: s.nom.trim(), couleur: s.couleur, polygon: ringOf(s.layer) })),
    };
    els.save.disabled = true;
    try {
      const res = await fetchJSON(`/api/admin/communes/${state.slug}/sectors`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      res.sectors.forEach((saved, i) => { if (state.sectors[i]) state.sectors[i].id = saved.id; });
      markClean();
      showToast("Secteurs enregistrés et publiés ✓");
    } catch (err) {
      els.save.disabled = false;
      if (err.status === 401) {
        showToast("Session expirée : reconnectez-vous puis réenregistrez.", true);
        showLogin();
      } else {
        showToast(`Erreur à l'enregistrement : ${err.message}`, true);
      }
    }
  }

  // ---- Chargement ------------------------------------------------------------------

  async function loadCommune(slug) {
    state.slug = slug;
    const data = await fetchJSON(`/api/admin/communes/${slug}`);
    state.data = data;
    clearCommuneLayers();
    buildBaseLayers(data);
    data.sectors.forEach((s) => addSector(s));
    markClean();
    recompute();
    renderList();
    const pts = data.addresses.map((a) => [a.lat, a.lon]);
    if (pts.length) state.map.fitBounds(pts, { padding: [20, 20] });
    else if (data.commune.mairie) state.map.setView([data.commune.mairie.lat, data.commune.mairie.lon], 14);
  }

  async function start() {
    showEditor();
    if (!state.map) initMap();
    const { communes } = await fetchJSON("/api/communes");
    if (!communes.length) {
      els.warnings.innerHTML = `<div class="warning danger">Aucune donnée de commune : lancez d'abord le pipeline (<code>docker compose run --rm pipeline</code>).</div>`;
      return;
    }
    els.select.innerHTML = communes.map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.nom)}</option>`).join("");
    await loadCommune(communes[0].slug);
  }

  els.select.addEventListener("change", async () => {
    if (state.dirty && !confirm("Des modifications ne sont pas enregistrées et seront perdues. Continuer ?")) {
      els.select.value = state.slug;
      return;
    }
    await loadCommune(els.select.value);
  });

  els.draw.addEventListener("click", () => {
    if (state.map.pm.globalDrawModeEnabled()) {
      state.map.pm.disableDraw();
      return;
    }
    stopEditing();
    const color = nextColor();
    state.map.pm.enableDraw("Polygon", {
      snappable: els.snap.checked,
      snapDistance: SNAP_DISTANCE,
      allowSelfIntersection: false,
      templineStyle: { color },
      hintlineStyle: { color, dashArray: [5, 5] },
      pathOptions: { color, fillColor: color },
    });
  });

  els.save.addEventListener("click", save);

  els.snap.addEventListener("change", () => {
    state.map.pm.setGlobalOptions({ snappable: els.snap.checked, snapDistance: SNAP_DISTANCE, allowSelfIntersection: false });
    if (state.editing) {
      const s = state.editing;
      stopEditing();
      startEditing(s);
    }
  });

  els.roads.addEventListener("change", () => {
    if (els.roads.checked) state.roadsLayer.addTo(state.map); else state.map.removeLayer(state.roadsLayer);
  });

  els.buildings.addEventListener("change", () => {
    if (els.buildings.checked) state.buildingsLayer.addTo(state.map); else state.map.removeLayer(state.buildingsLayer);
  });

  els.importAuto.addEventListener("click", () => {
    const auto = state.data.auto_sectors || [];
    if (!auto.length) { showToast("Pas de proposition automatique disponible.", true); return; }
    if (state.sectors.length && !confirm("Remplacer les secteurs affichés par la proposition automatique ?")) return;
    stopEditing();
    [...state.sectors].forEach((s) => { state.map.removeLayer(s.layer); state.map.removeLayer(s.label); });
    state.sectors = [];
    state.selected = null;
    auto.forEach((s) => addSector({ id: null, nom: s.nom, couleur: s.couleur, polygon: s.polygon }));
    markDirty();
    recompute();
    renderList();
    showToast("Proposition importée : vérifiez les alertes puis enregistrez.");
  });

  els.resetStatus.addEventListener("click", async () => {
    if (!confirm("Effacer TOUS les statuts (fait / absent / refus) de cette commune ? Action irréversible.")) return;
    try {
      await fetchJSON(`/api/admin/communes/${state.slug}/reset-statuses`, { method: "POST" });
      showToast("Statuts remis à zéro.");
    } catch (err) {
      showToast(err.message, true);
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  (async () => {
    try {
      await fetchJSON("/api/admin/me");
      await start();
    } catch (err) {
      if (err.status === 401) showLogin();
      else showToast(`Erreur : ${err.message}`, true);
    }
  })();
})();
