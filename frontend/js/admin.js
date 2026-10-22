(() => {
  "use strict";
  const {
    PALETTE, escapeHtml, fetchJSON, showToast, labelPoint, formatDistance, formatDuration,
    toPolys, pointInPolys, OFF_ROAD, addBaseLayers, sectorCode, labelHtml,
  } = window.Common;
  const Geometry = window.Geometry;

  const SNAP_DISTANCE = 20;
  const OUTSIDE_COLOR = "#111111";
  const MIN_PER_KM = 2; // ~30 km/h
  const MAX_HISTORY = 100;
  const NOT_DRIVEN = new Set(["footway", "path", "cycleway", "steps", "bridleway", "track", "pedestrian", "corridor"]);

  const $ = (id) => document.getElementById(id);
  const els = {
    loginView: $("login-view"),
    loginForm: $("login-form"),
    password: $("password"),
    loginError: $("login-error"),
    editorView: $("editor-view"),
    select: $("commune-select"),
    logout: $("btn-logout"),
    draw: $("btn-draw"),
    newHamlets: $("btn-new-hamlets"),
    roadSnap: $("btn-road-snap"),
    neighbours: $("neighbours-toggle"),
    undo: $("btn-undo"),
    redo: $("btn-redo"),
    save: $("btn-save"),
    dirtyHint: $("dirty-hint"),
    banner: $("mode-banner"),
    bannerText: $("mode-text"),
    bannerDone: $("mode-done"),
    snap: $("snap-toggle"),
    roads: $("roads-toggle"),
    buildings: $("buildings-toggle"),
    warnings: $("warnings"),
    balance: $("balance-rows"),
    minPerAddress: $("min-per-address"),
    list: $("sector-editor-list"),
    excludedCount: $("excluded-count"),
    excludedList: $("excluded-list"),
    suivi: $("suivi-toggle"),
    annee: $("annee-input"),
    versionsBtn: $("btn-versions"),
    versionsList: $("versions-list"),
    importAuto: $("btn-import-auto"),
    printAll: $("btn-print-all"),
    resetBlock: $("reset-status-block"),
    resetStatus: $("btn-reset-status"),
  };

  const state = {
    map: null,
    canvas: null,
    slug: null,
    data: null,
    sectors: [], // {id, nom, couleur, layer, label, count, groups, km, minutes}
    markers: [],
    owners: [], // pour chaque adresse : index du secteur qui la contient (ou null)
    excluded: new Set(),
    roadSegments: [],
    roadsLayer: null,
    buildingsLayer: null,
    contourLayer: null,
    editing: null,
    selected: null,
    hamletTarget: null, // secteur en cours de construction par hameaux
    hamletNew: false, // le prochain clic crée un nouveau secteur
    cutTarget: null, // secteur à couper par une ligne
    mergeSource: null, // secteur auquel on réunit le prochain secteur cliqué
    neighboursLayer: null, // secteurs des autres communes (repère, aimantables)
    history: [],
    future: [],
    savedSnapshot: "[]",
    savedById: new Map(),
  };

  const storage = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* indisponible */ } },
  };
  els.minPerAddress.value = storage.get("admin-min-per-address", "2");

  // ---- Connexion ------------------------------------------------------------------

  function showLogin() {
    els.loginView.hidden = false;
    els.editorView.hidden = true;
    $("teams-view").hidden = true;
    $("bilan-view").hidden = true;
    $("comptes-view").hidden = true;
    $("admin-tabs").hidden = true;
    $("btn-me").hidden = true;
    els.select.hidden = true;
    els.logout.hidden = true;
    els.password.focus();
  }

  // compte connecté et ses droits (rôle) : les onglets suivent
  let me = null;
  const can = (...perms) => !!me && perms.some((p) => me.permissions.includes(p));
  const TAB_PERMS = { secteurs: ["secteurs"], equipes: ["equipes"], bilan: ["suivi", "dons", "reglages"], comptes: ["comptes", "journal"] };
  const allowedTabs = () => Object.keys(TAB_PERMS).filter((t) => can(...TAB_PERMS[t]));

  /** Onglet affiché : « secteurs » (carte d'édition), « equipes », « bilan » ou « comptes ». */
  function currentTab() {
    const asked = { "#equipes": "equipes", "#bilan": "bilan", "#comptes": "comptes" }[location.hash] || "secteurs";
    const ok = allowedTabs();
    return ok.includes(asked) ? asked : ok[0] || "secteurs";
  }

  function showEditor() {
    const tab = currentTab();
    els.loginView.hidden = true;
    $("admin-tabs").hidden = false;
    document.querySelectorAll(".admin-tab").forEach((a) => {
      a.classList.toggle("active", a.dataset.tab === tab);
      a.hidden = !allowedTabs().includes(a.dataset.tab);
    });
    els.editorView.hidden = tab !== "secteurs";
    $("teams-view").hidden = tab !== "equipes";
    $("bilan-view").hidden = tab !== "bilan";
    $("comptes-view").hidden = tab !== "comptes";
    els.select.hidden = tab !== "secteurs";
    els.logout.hidden = false;
    if (tab === "secteurs" && state.map) setTimeout(() => (state.fitPending ? fitCommune() : state.map.invalidateSize()), 50);
    if (tab === "comptes") {
      window.Comptes.open({
        onUnauthorized: () => { showToast("Session expirée : reconnectez-vous.", true); showLogin(); },
      }).catch((err) => { if (err.status !== 401) showToast(`Erreur de chargement : ${err.message}`, true); });
    }
    if (tab === "bilan") {
      window.Bilan.open({
        perms: me.permissions,
        onUnauthorized: () => { showToast("Session expirée : reconnectez-vous.", true); showLogin(); },
      }).catch((err) => { if (err.status !== 401) showToast(`Erreur de chargement : ${err.message}`, true); });
    }
    if (tab === "equipes") {
      if (isDirty()) showToast("Des secteurs ne sont pas enregistrés : l'onglet Équipes montre la dernière version enregistrée.");
      window.Equipes.open({
        onUnauthorized: () => { showToast("Session expirée : reconnectez-vous.", true); showLogin(); },
      }).catch((err) => { if (err.status !== 401) showToast(`Erreur de chargement : ${err.message}`, true); });
    }
  }

  window.addEventListener("hashchange", () => { if (!els.loginView.hidden) return; showEditor(); });

  els.loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.loginError.hidden = true;
    try {
      await fetchJSON("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiant: $("login-id").value.trim(), password: els.password.value }),
      });
    } catch (err) {
      els.loginError.textContent = err.message;
      els.loginError.hidden = false;
      return;
    }
    els.password.value = "";
    const wasEditing = !!state.data;
    const before = me && me.id;
    await loadMe();
    if (wasEditing && before === me.id) {
      showEditor();
      showToast("Reconnecté : vous pouvez enregistrer.");
    } else {
      await start().catch((err) => showToast(`Erreur de chargement : ${err.message}`, true));
    }
  });

  els.logout.addEventListener("click", async () => {
    if (isDirty() && !confirm("Des modifications ne sont pas enregistrées. Se déconnecter quand même ?")) return;
    await fetchJSON("/api/admin/logout", { method: "POST" }).catch(() => {});
    state.savedSnapshot = serialize();
    location.reload();
  });

  // ---- Carte ------------------------------------------------------------------------

  function initMap() {
    // une vue initiale est indispensable avant d'ajouter des calques (rendu canvas)
    state.map = L.map("admin-map", { zoomControl: true }).setView([45.742, 4.57], 13);
    addBaseLayers(state.map);
    state.canvas = L.canvas({ padding: 0.5, tolerance: 6 });
    state.map.pm.setLang("fr");
    state.map.pm.setGlobalOptions({ snappable: true, snapDistance: SNAP_DISTANCE, allowSelfIntersection: false });

    state.map.on("click", onMapClick);
    state.map.on("mousemove", onMapMove);
    const drawLabel = els.draw.innerHTML;
    state.map.on("pm:drawstart", () => { els.draw.textContent = "✖ Annuler le dessin"; els.draw.classList.add("active"); });
    state.map.on("pm:drawend", () => { els.draw.innerHTML = drawLabel; els.draw.classList.remove("active"); });
    state.map.on("pm:create", (e) => {
      if (e.shape === "Line") {
        state.map.removeLayer(e.layer);
        finishCut(e.layer.getLatLngs().map((p) => [p.lat, p.lng]));
        return;
      }
      const polys = polysOf(e.layer);
      state.map.removeLayer(e.layer);
      const sector = addSector({ id: null, nom: `Secteur ${state.sectors.length + 1}`, couleur: nextColor(), polygon: polys });
      changed();
      renderList();
      selectSector(sector, true);
      focusName(sector);
    });
  }

  function focusName(sector) {
    const input = document.querySelector(`.sector-edit-card[data-index="${state.sectors.indexOf(sector)}"] input[type="text"]`);
    if (input) { input.focus(); input.select(); }
  }

  function clearSectorLayers() {
    if (state.editing) stopEditing();
    for (const s of state.sectors) { state.map.removeLayer(s.layer); state.map.removeLayer(s.label); }
    state.sectors = [];
    state.selected = null;
  }

  function clearCommuneLayers() {
    state.map.pm.disableDraw();
    stopAllModes();
    clearSectorLayers();
    for (const layer of [state.roadsLayer, state.buildingsLayer, state.contourLayer]) {
      if (layer) state.map.removeLayer(layer);
    }
    state.markers.forEach((m) => state.map.removeLayer(m));
    state.markers = [];
  }

  function segLength(a, b) {
    const dy = (b[0] - a[0]) * 110540;
    const dx = (b[1] - a[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180);
    return Math.hypot(dx, dy);
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

    // segments de route carrossables, pour estimer les km par secteur
    state.roadSegments = [];
    for (const r of data.roads) {
      if (NOT_DRIVEN.has(r.type)) continue;
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1];
        const b = r.points[i];
        state.roadSegments.push({ lat: (a[0] + b[0]) / 2, lon: (a[1] + b[1]) / 2, m: segLength(a, b) });
      }
    }

    state.buildingsLayer = L.layerGroup(data.buildings.map((b) => L.polygon(b, {
      renderer: state.canvas, color: "#8a5a2b", weight: 1, fillOpacity: 0.35,
      interactive: false, pmIgnore: true, snapIgnore: true,
    })));
    if (els.buildings.checked) state.buildingsLayer.addTo(state.map);

    // Les clics et le survol des adresses sont gérés au niveau de la carte (voir
    // nearestAddress) : ainsi ils marchent même quand un secteur est dessiné par-dessus.
    state.markers = data.addresses.map((a) => L.circleMarker([a.lat, a.lon], {
      renderer: state.canvas, radius: 4, weight: 1, color: "#fff", fillColor: OUTSIDE_COLOR, fillOpacity: 1,
      interactive: false, pmIgnore: true, snapIgnore: true,
    }).addTo(state.map));
  }

  const HIT_PX = 10;

  /** Index de l'adresse affichée la plus proche du point écran, à moins de HIT_PX pixels. */
  function nearestAddress(latlng) {
    if (!state.data) return null;
    const p = state.map.latLngToContainerPoint(latlng);
    const size = state.map.getSize();
    let best = null;
    let bestD = HIT_PX * HIT_PX;
    state.data.addresses.forEach((a, idx) => {
      const q = state.map.latLngToContainerPoint([a.lat, a.lon]);
      if (q.x < -HIT_PX || q.y < -HIT_PX || q.x > size.x + HIT_PX || q.y > size.y + HIT_PX) return;
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d <= bestD) { bestD = d; best = idx; }
    });
    return best;
  }

  function onMapClick(e) {
    if (state.map.pm.globalDrawModeEnabled() || state.editing || state.mergeSource) return;
    const idx = nearestAddress(e.latlng);
    if (idx === null) return;
    const a = state.data.addresses[idx];
    if (state.hamletTarget || state.hamletNew) {
      if (state.excluded.has(a.id)) { showToast("Adresse exclue : réintégrez-la d'abord pour l'utiliser.", true); return; }
      toggleHamlet(a.groupe_id);
    } else {
      openAddressPopup(idx);
    }
  }

  let hoverTimer = null;
  let hoverTip = null;
  function onMapMove(e) {
    if (hoverTimer) return;
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      const idx = state.map.pm.globalDrawModeEnabled() ? null : nearestAddress(e.latlng);
      state.map.getContainer().classList.toggle("over-address", idx !== null);
      if (idx === null) {
        if (hoverTip) { state.map.removeLayer(hoverTip); hoverTip = null; }
        return;
      }
      const a = state.data.addresses[idx];
      const html = `${escapeHtml(a.label)}<br><small>${escapeHtml(a.groupe)}${state.excluded.has(a.id) ? " · exclue" : ""}</small>`;
      if (!hoverTip) hoverTip = L.tooltip({ direction: "top", offset: [0, -6] });
      hoverTip.setLatLng([a.lat, a.lon]).setContent(html);
      if (!state.map.hasLayer(hoverTip)) hoverTip.addTo(state.map);
    }, 60);
  }

  /** Contours d'un calque Leaflet au format canonique [[contour, enclave...], ...]. */
  function polysOf(layer) {
    let ll = layer.getLatLngs();
    if (!Array.isArray(ll[0][0])) ll = [ll]; // polygone simple -> un seul morceau
    return ll.map((poly) => poly.map((ring) => ring.map((p) => [+p.lat.toFixed(6), +p.lng.toFixed(6)])));
  }

  function nextColor() {
    const used = new Set(state.sectors.map((s) => s.couleur.toLowerCase()));
    return PALETTE.find((c) => !used.has(c)) || PALETTE[state.sectors.length % PALETTE.length];
  }

  function sectorStyle(sector) {
    const selected = state.selected === sector || state.hamletTarget === sector;
    return { color: sector.couleur, fillColor: sector.couleur, weight: selected ? 4 : 2, fillOpacity: selected ? 0.25 : 0.15 };
  }

  function codeOf(sector) {
    const i = state.sectors.indexOf(sector);
    return sectorCode(state.data && state.data.commune.nom, i < 0 ? state.sectors.length : i);
  }

  function labelIcon(sector) {
    return L.divIcon({ className: "sector-label-icon", html: labelHtml(sector, codeOf(sector)), iconSize: null });
  }

  function addSector({ id, nom, couleur, polygon }) {
    const sector = { id, nom, couleur, count: 0, groups: 0, km: 0, minutes: 0 };
    const polys = toPolys(polygon);
    sector.layer = L.polygon(polys, {}).addTo(state.map);
    sector.layer.setStyle(sectorStyle(sector));
    sector.label = L.marker(sector.layer.getBounds().getCenter(), {
      icon: labelIcon(sector), interactive: false, keyboard: false, pmIgnore: true, snapIgnore: true,
    }).addTo(state.map);
    sector.layer.on("click", () => {
      if (state.mergeSource) { finishMerge(sector); return; }
      if (state.map.pm.globalDrawModeEnabled() || state.hamletTarget || state.hamletNew) return;
      selectSector(sector, true);
    });
    sector.layer.on("pm:edit", () => { changed(); updateCards(); });
    state.sectors.push(sector);
    return sector;
  }

  function setSectorPolys(sector, polys) {
    const wasEditing = state.editing === sector;
    if (wasEditing) stopEditing();
    sector.layer.setLatLngs(polys);
    sector.layer.setStyle(sectorStyle(sector));
    if (wasEditing) startEditing(sector);
  }

  function removeSector(sector) {
    if (state.editing === sector) stopEditing();
    if (state.hamletTarget === sector) stopHamletMode();
    state.map.removeLayer(sector.layer);
    state.map.removeLayer(sector.label);
    state.sectors = state.sectors.filter((s) => s !== sector);
    if (state.selected === sector) state.selected = null;
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
    stopHamletMode();
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

  // ---- Mode « hameaux » ------------------------------------------------------------

  function activeGroupAddresses(groupId) {
    return state.data.addresses.filter((a) => a.groupe_id === groupId && !state.excluded.has(a.id));
  }

  function updateBanner() {
    const active = state.hamletTarget || state.hamletNew || state.cutTarget || state.mergeSource;
    els.banner.hidden = !active;
    state.map.getContainer().classList.toggle("hamlet-mode", Boolean(state.hamletTarget || state.hamletNew));
    if (state.cutTarget) {
      els.bannerText.textContent = `Couper « ${state.cutTarget.nom} » : tracez une ligne qui le traverse de part en part, puis recliquez le dernier point.`;
    } else if (state.mergeSource) {
      els.bannerText.textContent = `Cliquez le secteur à réunir avec « ${state.mergeSource.nom} ».`;
    } else if (state.hamletNew) {
      els.bannerText.textContent = "Nouveau secteur : cliquez une maison pour y mettre tout son hameau.";
    } else if (state.hamletTarget) {
      els.bannerText.textContent = `« ${state.hamletTarget.nom} » : cliquez une maison pour ajouter son hameau (recliquez pour le retirer).`;
    }
  }

  function startHamletMode(sector) {
    stopEditing();
    state.map.pm.disableDraw();
    state.hamletNew = !sector;
    state.hamletTarget = sector || null;
    if (sector) selectSector(sector, false);
    state.sectors.forEach((s) => s.layer.setStyle(sectorStyle(s)));
    updateBanner();
    renderList();
  }

  function stopHamletMode() {
    if (!state.hamletTarget && !state.hamletNew) return;
    state.hamletTarget = null;
    state.hamletNew = false;
    state.sectors.forEach((s) => s.layer.setStyle(sectorStyle(s)));
    updateBanner();
    renderList();
  }

  /** Met tout le hameau `groupId` dans `target` et le retire des autres secteurs. */
  function moveGroupTo(groupId, target) {
    const addrs = activeGroupAddresses(groupId);
    if (!addrs.length) return;
    const shape = Geometry.hamletShape(addrs);
    setSectorPolys(target, Geometry.union(polysOf(target.layer), shape));
    for (const other of [...state.sectors]) {
      if (other === target || !Geometry.intersects(polysOf(other.layer), shape)) continue;
      const rest = Geometry.difference(polysOf(other.layer), shape);
      if (rest.length) setSectorPolys(other, rest);
      else {
        removeSector(other);
        showToast(`« ${other.nom} » ne contenait que ce hameau : secteur supprimé (↶ pour annuler).`);
      }
    }
  }

  function toggleHamlet(groupId) {
    const addrs = activeGroupAddresses(groupId);
    if (!addrs.length) return;
    const name = addrs[0].groupe;
    try {
      if (state.hamletNew) {
        const sector = addSector({ id: null, nom: name, couleur: nextColor(), polygon: Geometry.union([], Geometry.hamletShape(addrs)) });
        moveGroupTo(groupId, sector); // le retire d'un éventuel autre secteur
        state.hamletNew = false;
        state.hamletTarget = sector;
        changed();
        renderList();
        selectSector(sector, true);
        updateBanner();
        showToast(`Secteur créé avec « ${name} ». Continuez à cliquer des hameaux, puis renommez-le.`);
        return;
      }
      const target = state.hamletTarget;
      const polys = polysOf(target.layer);
      const allInside = addrs.every((a) => pointInPolys(a.lat, a.lon, polys));
      if (allInside) {
        const rest = Geometry.difference(polys, Geometry.hamletShape(addrs));
        if (!rest.length) { showToast("C'est le seul hameau du secteur : supprimez plutôt le secteur.", true); return; }
        setSectorPolys(target, rest);
        showToast(`« ${name} » retiré de « ${target.nom} ».`);
      } else {
        moveGroupTo(groupId, target);
        showToast(`« ${name} » ajouté à « ${target.nom} ».`);
      }
      changed();
      renderList();
    } catch (err) {
      console.error(err);
      showToast(`Opération impossible sur ce hameau : ${err.message}`, true);
    }
  }

  els.newHamlets.addEventListener("click", () => {
    if (state.hamletNew) stopHamletMode(); else startHamletMode(null);
  });
  els.bannerDone.addEventListener("click", stopAllModes);

  function stopAllModes() {
    stopHamletMode();
    if (state.cutTarget) { state.cutTarget = null; state.map.pm.disableDraw(); }
    state.mergeSource = null;
    updateBanner();
  }

  // ---- Couper / fusionner ------------------------------------------------------------

  function startCut(sector) {
    stopAllModes();
    stopEditing();
    state.cutTarget = sector;
    selectSector(sector, false);
    updateBanner();
    state.map.pm.enableDraw("Line", {
      snappable: els.snap.checked, snapDistance: SNAP_DISTANCE,
      templineStyle: { color: "#d00", weight: 3 }, hintlineStyle: { color: "#d00", dashArray: [5, 5] },
    });
  }

  function finishCut(line) {
    const target = state.cutTarget;
    state.cutTarget = null;
    updateBanner();
    if (!target || line.length < 2) return;
    let halves = null;
    try { halves = Geometry.splitByLine(polysOf(target.layer), line); } catch (err) { console.error(err); }
    if (!halves) {
      showToast("La ligne doit traverser complètement le secteur (d'un bord à l'autre).", true);
      return;
    }
    setSectorPolys(target, halves[0]);
    const other = addSector({ id: null, nom: `${target.nom} (2)`, couleur: nextColor(), polygon: halves[1] });
    changed();
    renderList();
    selectSector(other, true);
    focusName(other);
    showToast("Secteur coupé en deux : renommez la nouvelle partie.");
  }

  function startMerge(sector) {
    stopAllModes();
    stopEditing();
    state.mergeSource = sector;
    selectSector(sector, false);
    updateBanner();
  }

  function finishMerge(other) {
    const target = state.mergeSource;
    state.mergeSource = null;
    updateBanner();
    if (!target || other === target) return;
    const a = polysOf(target.layer);
    const b = polysOf(other.layer);
    let merged;
    try { merged = Geometry.unionPolys(a, b); } catch { merged = null; }
    if (!merged || !merged.length) merged = [...a, ...b]; // repli exact : les deux contours côte à côte
    setSectorPolys(target, merged);
    removeSector(other);
    changed();
    renderList();
    showToast(`« ${other.nom} » réuni à « ${target.nom} ».`);
  }

  // ---- Recalage sur les routes -------------------------------------------------------

  els.roadSnap.addEventListener("click", () => {
    if (!state.sectors.length) { showToast("Créez d'abord des secteurs.", true); return; }
    if (!confirm("Redessiner toutes les limites pour qu'elles passent par les routes ?\n\n"
      + "Aucune maison ne change de secteur. Les zones sans maison et les maisons hors secteur "
      + "sont rattachées au secteur le plus proche : toute la commune sera couverte.\n\n(↶ pour annuler ensuite)")) return;
    stopAllModes();
    stopEditing();
    showToast("Calcul en cours…");
    setTimeout(() => {
      try {
        const addresses = state.data.addresses.map((a, idx) => ({ lat: a.lat, lon: a.lon, sector: state.owners[idx] }));
        const result = Geometry.roadPartition({
          roads: state.data.roads, contour: state.data.commune.contour, addresses, nSectors: state.sectors.length,
        });
        result.forEach((polys, i) => { if (polys) setSectorPolys(state.sectors[i], polys); });
        changed();
        renderList();
        showToast("Limites recalées sur les routes ✓ (↶ pour revenir en arrière)");
      } catch (err) {
        console.error(err);
        showToast(`Recalage impossible : ${err.message}`, true);
      }
    }, 50);
  });

  // ---- Adresses exclues ------------------------------------------------------------

  function openAddressPopup(idx) {
    const a = state.data.addresses[idx];
    const excluded = state.excluded.has(a.id);
    const group = state.data.addresses.filter((x) => x.groupe_id === a.groupe_id);
    const box = document.createElement("div");
    box.innerHTML = `<strong>${escapeHtml(a.label)}</strong><br><span class="hint">${escapeHtml(a.groupe)}${excluded ? " · <b>exclue</b>" : ""}</span>`;
    const actions = document.createElement("div");
    actions.className = "popup-actions";
    if (excluded) {
      actions.append(button("Réintégrer cette adresse", "btn", () => setExcluded([a.id], false)));
    } else {
      actions.append(button("Exclure cette adresse", "btn danger", () => setExcluded([a.id], true)));
      if (group.length > 1) {
        actions.append(button(`Exclure tout « ${a.groupe} » (${group.length})`, "btn danger", () => {
          if (confirm(`Exclure les ${group.length} adresses de « ${a.groupe} » ?`)) setExcluded(group.map((x) => x.id), true);
        }));
      }
    }
    box.appendChild(actions);
    L.popup({ maxWidth: 280 }).setLatLng([a.lat, a.lon]).setContent(box).openOn(state.map);
  }

  async function setExcluded(ids, excluded) {
    try {
      const res = await fetchJSON(`/api/admin/communes/${state.slug}/excluded`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address_ids: ids, excluded }),
      });
      state.excluded = new Set(res.excluded);
      state.map.closePopup();
      recompute();
      renderExcluded();
      showToast(excluded ? `${ids.length} adresse(s) exclue(s) ✓` : `${ids.length} adresse(s) réintégrée(s) ✓`);
    } catch (err) {
      if (err.status === 401) { showToast("Session expirée : reconnectez-vous.", true); showLogin(); }
      else showToast(err.message, true);
    }
  }

  function renderExcluded() {
    const list = state.data.addresses.filter((a) => state.excluded.has(a.id));
    els.excludedCount.textContent = String(list.length);
    els.excludedList.innerHTML = list.length ? "" : `<p class="hint">Aucune adresse exclue.</p>`;
    for (const a of list) {
      const row = document.createElement("div");
      row.className = "excluded-row";
      row.innerHTML = `<span>${escapeHtml(a.label)}<br><span class="hint">${escapeHtml(a.groupe)}</span></span>`;
      const btns = document.createElement("span");
      btns.append(
        button("Voir", "btn small", () => state.map.setView([a.lat, a.lon], 18)),
        button("Réintégrer", "btn small", () => setExcluded([a.id], false)),
      );
      row.appendChild(btns);
      els.excludedList.appendChild(row);
    }
  }

  // ---- Historique (annuler / rétablir) ----------------------------------------------

  function serialize() {
    return JSON.stringify(state.sectors.map((s) => ({ id: s.id, nom: s.nom, couleur: s.couleur, polygon: polysOf(s.layer) })));
  }

  function isDirty() {
    return state.data !== null && serialize() !== state.savedSnapshot;
  }

  function refreshDirty() {
    const dirty = isDirty();
    els.save.disabled = !dirty;
    els.dirtyHint.hidden = !dirty;
    els.undo.disabled = state.history.length <= 1;
    els.redo.disabled = state.future.length === 0;
  }

  /** À appeler après chaque modification : mémorise l'état et recalcule tout. */
  function changed() {
    const snap = serialize();
    if (state.history[state.history.length - 1] !== snap) {
      state.history.push(snap);
      if (state.history.length > MAX_HISTORY) state.history.shift();
      state.future = [];
    }
    recompute();
    refreshDirty();
  }

  function restore(snapshot) {
    const hamletIndex = state.hamletTarget ? state.sectors.indexOf(state.hamletTarget) : -1;
    clearSectorLayers();
    JSON.parse(snapshot).forEach((s) => addSector(s));
    state.hamletTarget = state.hamletTarget && state.sectors[hamletIndex] ? state.sectors[hamletIndex] : null;
    updateBanner();
    recompute();
    renderList();
    refreshDirty();
  }

  function undo() {
    if (state.history.length <= 1) return;
    state.map.pm.disableDraw();
    state.future.push(state.history.pop());
    restore(state.history[state.history.length - 1]);
  }

  function redo() {
    if (!state.future.length) return;
    state.map.pm.disableDraw();
    const snap = state.future.pop();
    state.history.push(snap);
    restore(snap);
  }

  function resetHistory() {
    state.history = [serialize()];
    state.future = [];
    refreshDirty();
  }

  els.undo.addEventListener("click", undo);
  els.redo.addEventListener("click", redo);
  document.addEventListener("keydown", (e) => {
    if (els.editorView.hidden) return;
    if (e.key === "Escape") { stopAllModes(); return; }
    if (!(e.ctrlKey || e.metaKey)) return;
    if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return; // annulation native du texte
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (key === "y" || (key === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  // ---- Affectation des adresses, alertes et équilibre --------------------------------

  function recompute() {
    if (!state.data) return;
    const polys = state.sectors.map((s) => polysOf(s.layer));
    const boxes = state.sectors.map((s) => s.layer.getBounds());
    const addresses = state.data.addresses;

    state.sectors.forEach((s) => { s.count = 0; s.groupSet = new Set(); s.km = 0; s.mine = []; });
    const outside = [];
    const overlap = [];
    const groupOwners = new Map();
    state.owners = [];

    addresses.forEach((a, idx) => {
      const marker = state.markers[idx];
      if (state.excluded.has(a.id)) {
        state.owners.push(null);
        marker.setStyle({ radius: 3, fillColor: "#ffffff", fillOpacity: 0.6, color: "#888888", weight: 1 });
        return;
      }
      const own = [];
      polys.forEach((p, i) => { if (boxes[i].contains([a.lat, a.lon]) && pointInPolys(a.lat, a.lon, p)) own.push(i); });
      const first = own.length ? own[0] : null;
      state.owners.push(first);
      if (first === null) outside.push(a);
      else {
        const s = state.sectors[first];
        s.count++;
        s.groupSet.add(a.groupe_id);
        s.mine.push(a);
      }
      if (own.length > 1) overlap.push({ a, own });
      if (!groupOwners.has(a.groupe_id)) groupOwners.set(a.groupe_id, { id: a.groupe_id, nom: a.groupe, owners: new Set(), addrs: [] });
      const g = groupOwners.get(a.groupe_id);
      g.owners.add(first);
      g.addrs.push(a);
      marker.setStyle({
        radius: 4,
        fillOpacity: 1,
        fillColor: first === null ? OUTSIDE_COLOR : state.sectors[first].couleur,
        color: own.length > 1 ? "#ff00ff" : "#fff",
        weight: own.length > 1 ? 2 : 1,
      });
    });

    for (const seg of state.roadSegments) {
      for (let i = 0; i < polys.length; i++) {
        if (boxes[i].contains([seg.lat, seg.lon]) && pointInPolys(seg.lat, seg.lon, polys[i])) {
          state.sectors[i].km += seg.m / 1000;
          break;
        }
      }
    }

    const minPerAddress = Number(els.minPerAddress.value) || 2;
    state.sectors.forEach((s, i) => {
      s.groups = s.groupSet.size;
      s.minutes = s.count * minPerAddress + s.km * MIN_PER_KM;
      s.label.setLatLng(labelPoint({ polygon: polys[i] }, s.mine));
    });

    const cutGroups = [...groupOwners.values()].filter((g) => g.owners.size > 1);
    renderWarnings({ outside, overlap, cutGroups });
    renderBalance();
    updateCards();
  }

  function sectorName(index) {
    return index === null ? "hors secteur" : `« ${state.sectors[index].nom} »`;
  }

  function renderWarnings({ outside, overlap, cutGroups }) {
    if (!state.sectors.length) {
      els.warnings.innerHTML = `<div class="warning info">Aucun secteur pour l'instant : créez-en un à partir de hameaux, dessinez-en un, ou importez la proposition automatique (« Autres outils » en bas).</div>`;
      return;
    }
    const items = [];
    cutGroups.forEach((g) => {
      const names = [...g.owners].map(sectorName).join(" et ");
      const fixes = [...g.owners].filter((i) => i !== null).map((i) => ({
        text: `Tout dans « ${state.sectors[i].nom} »`,
        run: () => {
          try { moveGroupTo(g.id, state.sectors[i]); changed(); renderList(); } catch (err) { showToast(err.message, true); }
        },
      }));
      items.push({ cls: "danger", text: `Hameau « ${escapeHtml(g.nom)} » coupé entre ${escapeHtml(names)} (${g.addrs.length} adresses).`, addrs: g.addrs, fixes });
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
    els.warnings.innerHTML = `<p class="hint">Ces alertes sont des aides : vous pouvez enregistrer malgré elles.</p>`;
    items.forEach((item) => {
      const div = document.createElement("div");
      div.className = `warning ${item.cls}`;
      const body = document.createElement("div");
      body.className = "warning-body";
      body.innerHTML = `<span>${item.text}</span>`;
      if (item.fixes && item.fixes.length) {
        const fixes = document.createElement("div");
        fixes.className = "fix-buttons";
        item.fixes.forEach((f) => fixes.appendChild(button(f.text, "btn small", f.run)));
        body.appendChild(fixes);
      }
      div.appendChild(body);
      div.appendChild(button("Voir", "btn small", () => {
        state.map.fitBounds(L.latLngBounds(item.addrs.map((a) => [a.lat, a.lon])), { padding: [60, 60], maxZoom: 17 });
      }));
      els.warnings.appendChild(div);
    });
  }

  function renderBalance() {
    const sectors = state.sectors;
    if (!sectors.length) { els.balance.innerHTML = `<p class="hint">—</p>`; return; }
    const mean = sectors.reduce((s, x) => s + x.minutes, 0) / sectors.length;
    const max = Math.max(...sectors.map((s) => s.minutes), 1);
    els.balance.innerHTML = sectors.map((s) => {
      const dev = mean ? Math.round(((s.minutes - mean) / mean) * 100) : 0;
      const devCls = Math.abs(dev) > 25 ? "bad" : Math.abs(dev) > 12 ? "meh" : "good";
      return `
        <div class="balance-row">
          <div class="balance-label"><span class="color-dot" style="background:${s.couleur}"></span><span class="balance-name">${escapeHtml(s.nom || "(sans nom)")}</span></div>
          <div class="balance-bar"><span style="width:${(s.minutes / max) * 100}%;background:${s.couleur}"></span><i style="left:${(mean / max) * 100}%"></i></div>
          <div class="balance-figures">≈ ${formatDuration(s.minutes)} · ${s.count} adr. · ${s.km.toFixed(1).replace(".", ",")} km
            <span class="dev ${devCls}">${dev > 0 ? "+" : ""}${dev} %</span></div>
        </div>`;
    }).join("") + `<p class="hint">Trait vertical = moyenne (${formatDuration(mean)}). Écart à la moyenne en %.</p>`;
  }

  els.minPerAddress.addEventListener("input", () => {
    storage.set("admin-min-per-address", els.minPerAddress.value);
    recompute();
  });

  // ---- Liste des secteurs ----------------------------------------------------------

  function limiteText(limite) {
    if (!limite || !limite.length) return "";
    return limite.map((r) => {
      if (r.nom === "__partie__") return `[morceau ${r.partie}]`;
      if (r.nom === "__enclave__") return "[enclave]";
      return `${r.nom === OFF_ROAD ? "champs" : r.nom} (${formatDistance(r.m)})`;
    }).join(" → ").replace(/\] → /g, "] ");
  }

  function savedInfo(sector) {
    if (sector.id === null) return { status: "new" };
    const saved = state.savedById.get(sector.id);
    if (!saved) return { status: "new" };
    if (saved.polygon !== JSON.stringify(polysOf(sector.layer))) return { status: "modified" };
    return { status: "saved", limite: saved.limite };
  }

  function renderList() {
    state.sectors.forEach((s) => s.label.setIcon(labelIcon(s)));
    els.list.innerHTML = "";
    state.sectors.forEach((sector, index) => {
      const card = document.createElement("div");
      card.className = "sector-edit-card";
      card.dataset.index = String(index);
      card.classList.toggle("selected", state.selected === sector || state.hamletTarget === sector);
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
        recompute();
        refreshDirty();
      });
      color.addEventListener("change", changed);

      const name = document.createElement("input");
      name.type = "text";
      name.value = sector.nom;
      name.maxLength = 120;
      name.placeholder = "Nom du secteur";
      name.setAttribute("aria-label", "Nom du secteur");
      name.addEventListener("input", () => {
        sector.nom = name.value;
        sector.label.setIcon(labelIcon(sector));
        renderBalance();
        updateBanner();
        refreshDirty();
      });
      name.addEventListener("change", changed);
      name.addEventListener("focus", () => selectSector(sector, false));

      const code = document.createElement("b");
      code.className = "sector-code";
      code.style.background = sector.couleur;
      code.textContent = codeOf(sector);
      row.append(code, color, name);

      const meta = document.createElement("div");
      meta.className = "sector-edit-meta";
      meta.dataset.role = "count";

      const limite = document.createElement("div");
      limite.className = "sector-edit-limite";
      limite.dataset.role = "limite";

      const actions = document.createElement("div");
      actions.className = "sector-edit-actions";
      const editing = state.editing === sector;
      const hamlets = state.hamletTarget === sector;
      actions.append(
        button(hamlets ? "✓ Fin hameaux" : "🏘 Hameaux", hamlets ? "btn small primary" : "btn small", () => {
          if (hamlets) stopHamletMode(); else startHamletMode(sector);
        }),
        button(editing ? "✓ Terminer" : "Modifier le tracé", editing ? "btn small primary" : "btn small", () => {
          if (editing) stopEditing(); else startEditing(sector);
        }),
        button("Centrer", "btn small", () => {
          selectSector(sector, false);
          state.map.fitBounds(sector.layer.getBounds(), { padding: [30, 30] });
        }),
        button("✂ Couper", "btn small", () => startCut(sector)),
        button("Fusionner…", "btn small", () => {
          if (state.sectors.length < 2) { showToast("Il faut au moins deux secteurs.", true); return; }
          startMerge(sector);
        }),
        button("🖨 Plan", "btn small", () => {
          if (savedInfo(sector).status !== "saved" || isDirty()) {
            showToast("Enregistrez d'abord pour imprimer le plan à jour.", true);
            return;
          }
          window.open(`plan.html#/${encodeURIComponent(state.slug)}/${sector.id}`, "_blank", "noopener");
        }),
        button("Supprimer", "btn small danger", () => {
          if (!confirm(`Supprimer le secteur « ${sector.nom} » ?`)) return;
          removeSector(sector);
          changed();
          renderList();
        }),
      );

      card.append(row, meta, limite, actions);
      els.list.appendChild(card);
    });
    updateCards();
  }

  function updateCards() {
    document.querySelectorAll(".sector-edit-card").forEach((card) => {
      const sector = state.sectors[Number(card.dataset.index)];
      if (!sector) return;
      const nParts = polysOf(sector.layer).length;
      card.querySelector('[data-role="count"]').textContent =
        `${sector.count} adresse(s) · ${sector.groups} groupe(s) d'habitations · ${sector.km.toFixed(1).replace(".", ",")} km de routes`
        + (nParts > 1 ? ` · ${nParts} morceaux` : "");
      const info = savedInfo(sector);
      const el = card.querySelector('[data-role="limite"]');
      if (info.status === "saved" && info.limite) {
        el.innerHTML = `<b>Limite :</b> ${escapeHtml(limiteText(info.limite))}`;
      } else {
        el.innerHTML = `<span class="hint">Description de la limite : disponible après enregistrement.</span>`;
      }
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

  function rememberSaved(sectors) {
    state.savedById = new Map(sectors.map((s) => [s.id, { polygon: JSON.stringify(s.polygon), limite: s.limite }]));
  }

  async function save() {
    const empty = state.sectors.find((s) => !s.nom.trim());
    if (empty) {
      showToast("Chaque secteur doit avoir un nom (c'est la seule chose obligatoire).", true);
      selectSector(empty, true);
      focusName(empty);
      return;
    }
    const payload = {
      sectors: state.sectors.map((s) => ({ id: s.id, nom: s.nom.trim(), couleur: s.couleur, polygon: polysOf(s.layer) })),
    };
    els.save.disabled = true;
    try {
      const res = await fetchJSON(`/api/admin/communes/${state.slug}/sectors`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      res.sectors.forEach((saved, i) => {
        if (!state.sectors[i]) return;
        state.sectors[i].id = saved.id;
        state.sectors[i].nom = saved.nom;
      });
      rememberSaved(res.sectors);
      state.savedSnapshot = serialize();
      resetHistory();
      updateCards();
      els.versionsList.innerHTML = "";
      showToast("Secteurs enregistrés et publiés ✓");
    } catch (err) {
      refreshDirty();
      if (err.status === 401) {
        showToast("Session expirée : reconnectez-vous puis réenregistrez.", true);
        showLogin();
      } else {
        showToast(`Erreur à l'enregistrement : ${err.message}`, true);
      }
    }
  }

  // ---- Réglages et versions --------------------------------------------------------

  async function loadSettings() {
    const settings = await fetchJSON("/api/admin/settings");
    els.suivi.checked = settings.suivi_adresses;
    els.resetBlock.hidden = !settings.suivi_adresses || !can("suivi");
    showAnnee(settings.annee);
  }

  function showAnnee(annee) {
    els.annee.value = annee;
    $("brand-title").textContent = window.Common.tourneeTitle(annee);
  }

  els.annee.addEventListener("change", async () => {
    const annee = Number(els.annee.value);
    if (!Number.isInteger(annee) || annee < 2000 || annee > 2100) {
      showToast("Année invalide (entre 2000 et 2100).", true);
      return;
    }
    try {
      const saved = await fetchJSON("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annee }),
      });
      showAnnee(saved.annee);
      showToast(`${window.Common.tourneeTitle(saved.annee)} : titre mis à jour sur le site public.`);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  els.suivi.addEventListener("change", async () => {
    const value = els.suivi.checked;
    try {
      await fetchJSON("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suivi_adresses: value }),
      });
      els.resetBlock.hidden = !value || !can("suivi");
      showToast(value ? "Suivi activé : les équipes le voient en se connectant avec leur code." : "Suivi désactivé : le site sert uniquement de plan.");
      window.dispatchEvent(new Event("suivi-change"));
    } catch (err) {
      els.suivi.checked = !value;
      showToast(err.message, true);
    }
  });

  els.versionsBtn.addEventListener("click", async () => {
    try {
      const { versions } = await fetchJSON(`/api/admin/communes/${state.slug}/versions`);
      if (!versions.length) { els.versionsList.innerHTML = `<p class="hint">Aucune version enregistrée pour l'instant.</p>`; return; }
      els.versionsList.innerHTML = "";
      versions.forEach((v, i) => {
        const row = document.createElement("div");
        row.className = "version-row";
        const date = new Date(v.saved_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
        row.innerHTML = `<div><b>${escapeHtml(date)}</b>${i === 0 ? ' <span class="badge">en ligne</span>' : ""}<br><span class="hint">${v.nb} secteur(s) : ${escapeHtml(v.noms.join(", "))}</span></div>`;
        row.appendChild(button("Charger", "btn small", async () => {
          if (isDirty() && !confirm("Remplacer les modifications non enregistrées par cette version ?")) return;
          const { sectors } = await fetchJSON(`/api/admin/communes/${state.slug}/versions/${v.id}`);
          state.map.pm.disableDraw();
          stopHamletMode();
          restore(JSON.stringify(sectors));
          changed();
          showToast("Version chargée : cliquez Enregistrer pour la republier.");
        }));
        els.versionsList.appendChild(row);
      });
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // ---- Chargement ------------------------------------------------------------------

  async function loadNeighbours(slug) {
    if (state.neighboursLayer) { state.map.removeLayer(state.neighboursLayer); state.neighboursLayer = null; }
    const { communes } = await fetchJSON("/api/communes");
    const others = await Promise.all(communes.filter((c) => c.slug !== slug)
      .map((c) => fetchJSON(`/api/communes/${encodeURIComponent(c.slug)}`).catch(() => null)));
    const layers = [];
    for (const d of others.filter(Boolean)) {
      if (d.commune.contour) {
        layers.push(L.geoJSON(d.commune.contour, {
          style: { color: "#555", weight: 2, dashArray: "6 6", fill: false }, interactive: false, pmIgnore: true, snapIgnore: false,
        }));
      }
      d.sectors.forEach((s, i) => {
        layers.push(L.polygon(toPolys(s.polygon), {
          color: s.couleur, weight: 2, dashArray: "5 5", fillOpacity: 0.06, interactive: false, pmIgnore: true, snapIgnore: false,
        }));
        layers.push(L.marker(labelPoint(s, s.addresses), {
          icon: L.divIcon({ className: "sector-label-icon small", html: labelHtml(s, sectorCode(d.commune.nom, i)), iconSize: null }),
          interactive: false, keyboard: false, pmIgnore: true, snapIgnore: true,
        }));
      });
    }
    state.neighboursLayer = L.layerGroup(layers);
    if (els.neighbours.checked) state.neighboursLayer.addTo(state.map);
  }

  els.neighbours.addEventListener("change", () => {
    if (!state.neighboursLayer) return;
    if (els.neighbours.checked) state.neighboursLayer.addTo(state.map); else state.map.removeLayer(state.neighboursLayer);
  });

  async function loadCommune(slug) {
    state.slug = slug;
    const data = await fetchJSON(`/api/admin/communes/${slug}`);
    clearCommuneLayers();
    loadNeighbours(slug).catch((err) => console.error(err));
    state.data = data;
    state.excluded = new Set(data.excluded || []);
    buildBaseLayers(data);
    data.sectors.forEach((s) => addSector(s));
    rememberSaved(data.sectors);
    state.savedSnapshot = serialize();
    resetHistory();
    recompute();
    renderList();
    renderExcluded();
    els.versionsList.innerHTML = "";
    els.printAll.href = "plan.html#/";
    fitCommune();
  }

  /** Cadre la carte sur la commune (plus tard si la carte est cachée par l'onglet Équipes). */
  function fitCommune() {
    const data = state.data;
    if (!data) return;
    if (els.editorView.hidden) { state.fitPending = true; return; }
    state.fitPending = false;
    state.map.invalidateSize();
    const pts = data.addresses.map((a) => [a.lat, a.lon]);
    if (pts.length) state.map.fitBounds(pts, { padding: [20, 20] });
    else if (data.commune.mairie) state.map.setView([data.commune.mairie.lat, data.commune.mairie.lon], 14);
  }

  async function loadMe() {
    me = await fetchJSON("/api/admin/me");
    window.Comptes.setMe(me);
    $("public-settings-card").hidden = !can("reglages");
  }

  async function start() {
    showEditor();
    await loadSettings();
    if (!can("secteurs")) return; // pas le droit de modifier les secteurs : pas d'éditeur à préparer
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
    if (isDirty() && !confirm("Des modifications ne sont pas enregistrées et seront perdues. Continuer ?")) {
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
    stopHamletMode();
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
    if (state.sectors.length && !confirm("Remplacer les secteurs affichés par la proposition automatique ? (↶ pour revenir en arrière)")) return;
    stopHamletMode();
    clearSectorLayers();
    auto.forEach((s) => addSector({ id: null, nom: s.nom, couleur: s.couleur, polygon: s.polygon }));
    changed();
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
    if (isDirty()) { e.preventDefault(); e.returnValue = ""; }
  });

  (async () => {
    try {
      await loadMe();
      await start();
    } catch (err) {
      if (err.status === 401) showLogin();
      else showToast(`Erreur : ${err.message}`, true);
    }
  })();
})();
