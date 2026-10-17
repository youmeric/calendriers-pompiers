(() => {
  "use strict";
  const {
    escapeHtml, fetchJSON, showToast, labelPoint, renderLimite, renderResume, hameauxPreview,
    toPolys, outerRings, holeRings, addBaseLayers, sectorCode, labelHtml, compactLabelsBelow,
    pointInPolys, distanceToEdge, formatDistance, normalizeText, tourneeTitle, teamLine, renderEquipe, hasTeam,
  } = window.Common;

  const STATUS = {
    fait: { label: "Fait", icon: "✓", color: "#2e9e5b" },
    absent: { label: "Absent", icon: "⏳", color: "#c9951d" },
    refus: { label: "Refus", icon: "✕", color: "#c0392b" },
  };
  const TODO_COLOR = "#3b4656";
  const QUEUE_KEY = "pompiers-pending-updates";
  const WORLD = [[85, -180], [85, 180], [-85, 180], [-85, -180]];

  const els = {
    mapEl: document.getElementById("map"),
    home: document.getElementById("home-panel"),
    buttons: document.getElementById("sector-buttons"),
    noSectors: document.getElementById("no-sectors"),
    sectorPanel: document.getElementById("sector-panel"),
    back: document.getElementById("btn-back"),
    share: document.getElementById("btn-share"),
    code: document.getElementById("sector-code"),
    search: document.getElementById("search"),
    searchResults: document.getElementById("search-results"),
    name: document.getElementById("sector-name"),
    progress: document.getElementById("sector-progress"),
    stats: document.getElementById("sector-stats"),
    hideDone: document.getElementById("hide-done"),
    list: document.getElementById("address-list"),
    printAll: document.getElementById("btn-print-all"),
    print: document.getElementById("btn-print"),
    summary: document.getElementById("sector-summary"),
    limite: document.getElementById("sector-limite"),
    resume: document.getElementById("sector-resume"),
    suiviBlock: document.getElementById("suivi-block"),
    panelToggle: document.getElementById("panel-toggle"),
    drawerBody: document.getElementById("drawer-body"),
    handleBack: document.getElementById("handle-back"),
  };

  const state = {
    communes: [], // [{slug, nom}] dans l'ordre de l'index
    all: {}, // slug -> données de la commune
    suivi: false,
    current: null, // {slug, sector}
    map: null,
    layer: null,
    markers: new Map(),
    locate: { active: false, marker: null, circle: null, centered: false, latlng: null },
    whereControl: null,
    searchIndex: [],
    pendingFocus: null, // élément à montrer après ouverture d'un secteur (recherche)
    me: null, // personne connectée avec son code : {admin, personne, roles: Map(secteur -> rôle), dons, sumup}
    tracking: null, // suivi du secteur ouvert : {sectorId, role, full, dons: Map(adresse -> [don]), totaux}
    annee: null,
  };

  const storage = {
    get(k, fallback) { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
  };

  // ---- File d'attente hors-ligne ---------------------------------------------------

  function readQueue() { try { return JSON.parse(storage.get(QUEUE_KEY, "[]")); } catch { return []; } }
  function writeQueue(q) { storage.set(QUEUE_KEY, JSON.stringify(q)); }

  async function sendStatus(slug, addressId, status) {
    return fetchJSON(`/api/communes/${slug}/addresses/${encodeURIComponent(addressId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }

  async function flushQueue() {
    const q = readQueue();
    if (!q.length) return;
    const remaining = [];
    for (const item of q) {
      try {
        await sendStatus(item.slug, item.addressId, item.status);
      } catch (err) {
        // 401/403 : plus d'accès (code changé, suivi coupé), 404 : adresse disparue -> on abandonne
        if (![401, 403, 404].includes(err.status)) remaining.push(item);
      }
    }
    writeQueue(remaining);
    if (!remaining.length) showToast("Modifications hors-ligne synchronisées ✓");
  }
  window.addEventListener("online", flushQueue);

  // ---- Carte -----------------------------------------------------------------------

  function initMap() {
    state.map = L.map("map", { zoomControl: true, zoomSnap: 0.5 }).setView([45.742, 4.57], 13);
    addBaseLayers(state.map);
    compactLabelsBelow(state.map, 14);
    state.layer = L.layerGroup().addTo(state.map);
    addLocateControl();
    const Where = L.Control.extend({
      options: { position: "bottomleft" },
      onAdd() {
        const div = L.DomUtil.create("div", "where-chip");
        div.hidden = true;
        L.DomEvent.disableClickPropagation(div);
        return div;
      },
    });
    state.whereControl = new Where();
    state.map.addControl(state.whereControl);
    state.map.on("click", (e) => {
      const m = nearestAddressMarker(e.latlng, 24);
      if (!m) return;
      m.openPopup();
      if (state.tracking) highlightRow(m.addressId);
    });
  }

  function addLocateControl() {
    const Locate = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const btn = L.DomUtil.create("button", "locate-btn leaflet-bar");
        btn.type = "button";
        btn.title = "Me localiser";
        btn.setAttribute("aria-label", "Me localiser");
        btn.innerHTML = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>`;
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, "click", () => toggleLocate(btn));
        return btn;
      },
    });
    state.map.addControl(new Locate());
    state.map.on("locationfound", (e) => {
      const loc = state.locate;
      if (!loc.marker) {
        loc.circle = L.circle(e.latlng, { radius: e.accuracy, color: "#1a73e8", weight: 1, fillOpacity: 0.1, interactive: false }).addTo(state.map);
        loc.marker = L.circleMarker(e.latlng, { radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1 }).addTo(state.map);
      } else {
        loc.marker.setLatLng(e.latlng);
        loc.circle.setLatLng(e.latlng).setRadius(e.accuracy);
      }
      loc.latlng = e.latlng;
      updateWhere();
      if (!loc.centered) {
        loc.centered = true;
        state.map.setView(e.latlng, Math.max(state.map.getZoom(), 16));
      }
    });
    state.map.on("locationerror", (e) => {
      if (e.code === 1) { // refus d'autorisation : inutile d'insister
        showToast("Position refusée : autorisez la localisation pour ce site.", true);
        stopLocate();
        return;
      }
      // perte de signal passagère : on continue à suivre la position
      const box = state.whereControl && state.whereControl.getContainer();
      if (box && !state.locate.latlng) {
        box.innerHTML = "📍 Recherche de votre position…";
        box.hidden = false;
      }
    });
  }

  function toggleLocate(btn) {
    if (state.locate.active) { stopLocate(); return; }
    state.locate.active = true;
    state.locate.centered = false;
    btn.classList.add("active");
    state.map.locate({ watch: true, enableHighAccuracy: true, setView: false });
  }

  function stopLocate() {
    const loc = state.locate;
    state.map.stopLocate();
    loc.active = false;
    if (loc.marker) { state.map.removeLayer(loc.marker); state.map.removeLayer(loc.circle); }
    loc.marker = loc.circle = null;
    loc.latlng = null;
    updateWhere();
    document.querySelector(".locate-btn")?.classList.remove("active");
  }

  /** « Dans quel secteur suis-je ? » : encart mis à jour à chaque position GPS. */
  function updateWhere() {
    const box = state.whereControl && state.whereControl.getContainer();
    if (!box) return;
    const pos = state.locate.latlng;
    if (!pos) { box.hidden = true; return; }
    const { lat, lng } = pos;
    const here = allSectors().find(({ sector }) => pointInPolys(lat, lng, toPolys(sector.polygon)));
    const tag = (s) => `<b class="sector-code" style="background:${s.couleur}">${escapeHtml(s.code)}</b> ${escapeHtml(s.nom)}`;
    let html;
    if (state.current) {
      const mine = state.current.sector;
      const polys = toPolys(mine.polygon);
      const dist = formatDistance(distanceToEdge(lat, lng, polys));
      if (pointInPolys(lat, lng, polys)) {
        html = `<span class="where-ok">✅ Vous êtes dans ce secteur</span><br>limite la plus proche à ${dist}`;
      } else {
        html = `<span class="where-out">⚠️ Vous êtes hors de ce secteur</span><br>sa limite est à ${dist}${here ? `<br>vous êtes dans ${tag(here.sector)}` : ""}`;
      }
    } else if (here) {
      const dist = formatDistance(distanceToEdge(lat, lng, toPolys(here.sector.polygon)));
      html = `📍 Vous êtes dans ${tag(here.sector)}<br><span class="hint">limite à ${dist}</span>
        <button type="button" class="btn small where-open">Ouvrir ce secteur</button>`;
    } else {
      html = `📍 Vous n'êtes dans aucun secteur`;
    }
    box.innerHTML = html;
    box.hidden = false;
    box.querySelector(".where-open")?.addEventListener("click", () => openSector(here.slug, here.sector.id));
  }

  function sectorLabel(sector, small) {
    return L.marker(labelPoint(sector, sector.addresses), {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: `sector-label-icon${small ? " small" : ""}`,
        html: labelHtml(sector, sector.code),
        iconSize: null,
      }),
    });
  }

  function contourLayer(commune) {
    if (!commune.contour) return null;
    return L.geoJSON(commune.contour, {
      style: { color: "#1c2430", weight: 2, dashArray: "8 6", fill: false, opacity: 0.6 },
      interactive: false,
    });
  }

  function allSectors() {
    return state.communes.flatMap((c) => (state.all[c.slug]?.sectors || []).map((s) => ({ slug: c.slug, sector: s })));
  }

  function statusColor(status) { return status ? STATUS[status].color : TODO_COLOR; }

  // ---- Vue d'ensemble : toutes les communes -------------------------------------------

  function showHome() {
    state.current = null;
    els.home.hidden = false;
    els.sectorPanel.hidden = true;
    setMapMode("map-home");
    updateHandle();
    state.layer.clearLayers();
    state.markers.clear();
    els.buttons.innerHTML = "";

    const bounds = L.latLngBounds([]);
    let total = 0;
    for (const c of state.communes) {
      const data = state.all[c.slug];
      if (!data) continue;
      const contour = contourLayer(data.commune);
      if (contour) { contour.addTo(state.layer); bounds.extend(contour.getBounds()); }

      if (data.sectors.length) {
        const heading = document.createElement("h3");
        heading.className = "commune-heading";
        heading.textContent = data.commune.nom;
        els.buttons.appendChild(heading);
      }
      for (const s of data.sectors) {
        total++;
        const poly = L.polygon(toPolys(s.polygon), { color: s.couleur, weight: 2, fillColor: s.couleur, fillOpacity: 0.3 });
        poly.on("click", () => openSector(c.slug, s.id));
        poly.addTo(state.layer);
        sectorLabel(s, false).addTo(state.layer);
        bounds.extend(poly.getBounds());
        els.buttons.appendChild(sectorButton(c.slug, s));
      }
    }
    els.noSectors.hidden = total > 0;
    els.printAll.hidden = total === 0;
    els.printAll.href = "plan.html#/";

    refreshMapSize(() => {
      if (bounds.isValid()) state.map.fitBounds(bounds, { padding: [16, 16] });
    });
    updateWhere();
  }

  function sectorButton(slug, s) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sector-button";
    btn.style.setProperty("--c", s.couleur);
    let meta = `${s.addresses.length} adresses`;
    const preview = hameauxPreview(s.resume);
    if (preview) meta += ` · ${escapeHtml(preview)}`;
    const role = state.me && state.me.roles.get(s.id);
    const progress = role ? `<span class="mine-tag">${role === "responsable" ? "★ Mon secteur (responsable)" : "Mon secteur"}</span>` : "";
    btn.innerHTML = `
      <b class="sector-code" style="background:${s.couleur}">${escapeHtml(s.code)}</b>
      <span class="sector-button-text">
        <span class="sector-button-name">${escapeHtml(s.nom)}</span>
        <span class="sector-button-meta">${meta}</span>${teamLine(s.equipe)}${progress}
      </span>
      <svg class="ico chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>`;
    btn.addEventListener("click", () => openSector(slug, s.id));
    return btn;
  }

  function openSector(slug, id) {
    const hash = `#/${encodeURIComponent(slug)}/${id}`;
    if (location.hash === hash) route().catch(onError); // même secteur : pas d'événement hashchange
    else location.hash = hash;
  }

  // ---- Vue d'un secteur --------------------------------------------------------------

  function showSector(slug, sector) {
    state.current = { slug, sector };
    els.home.hidden = true;
    els.sectorPanel.hidden = false;
    setMapMode("map-sector");
    state.layer.clearLayers();
    state.markers.clear();

    const polys = toPolys(sector.polygon);
    // tout ce qui est hors du secteur est assombri
    const mask = { stroke: false, fillColor: "#0f172a", fillOpacity: 0.38, interactive: false };
    L.polygon([WORLD, ...outerRings(polys)], mask).addTo(state.layer);
    // les enclaves ne font pas partie du secteur : assombries elles aussi
    holeRings(polys).forEach((hole) => L.polygon(hole, mask).addTo(state.layer));
    for (const c of state.communes) {
      const contour = state.all[c.slug] && contourLayer(state.all[c.slug].commune);
      if (contour) contour.addTo(state.layer);
    }
    for (const { sector: other } of allSectors()) {
      if (other.id === sector.id) continue;
      L.polygon(toPolys(other.polygon), { color: other.couleur, weight: 1.5, dashArray: "4 4", fill: false, interactive: false })
        .addTo(state.layer);
      sectorLabel(other, true).addTo(state.layer);
    }
    const outline = L.polygon(polys, { color: sector.couleur, weight: 5, fill: false, interactive: false })
      .addTo(state.layer);

    const suivi = canTrack(sector);
    state.tracking = null;
    for (const a of sector.addresses) {
      const m = L.circleMarker([a.lat, a.lon], {
        radius: suivi ? 6 : 4, color: "#fff", weight: 1.5, fillColor: suivi ? statusColor(a.status) : TODO_COLOR, fillOpacity: 1,
      });
      m.bindPopup(placePopup(a.label, a.groupe, a.lat, a.lon));
      m.addressId = a.id;
      if (suivi) m.on("click", () => highlightRow(a.id));
      m.addTo(state.layer);
      state.markers.set(a.id, m);
    }

    els.code.textContent = sector.code;
    els.code.style.background = sector.couleur;
    els.name.textContent = sector.nom;
    updateHandle();
    const communeNom = state.all[slug].commune.nom;
    els.summary.textContent = `${communeNom} · ${sector.addresses.length} adresses${polys.length > 1 ? ` · ${polys.length} morceaux` : ""}`;
    els.print.href = `plan.html#/${encodeURIComponent(slug)}/${sector.id}`;
    renderLimite(els.limite, sector.limite);
    renderResume(els.resume, sector.resume);
    const equipeCard = document.getElementById("equipe-card");
    equipeCard.hidden = !hasTeam(sector.equipe);
    if (!equipeCard.hidden) renderEquipe(document.getElementById("sector-equipe"), sector.equipe);
    els.suiviBlock.hidden = true;
    renderLocked(sector);
    if (suivi) loadTracking(slug, sector).catch(onTrackingError);
    window.scrollTo({ top: 0 });
    els.drawerBody.scrollTop = 0;

    refreshMapSize(() => {
      state.map.fitBounds(outline.getBounds(), { padding: [20, 20] });
      focusPending();
    });
    updateWhere();
  }

  function focusPending() {
    const f = state.pendingFocus;
    state.pendingFocus = null;
    if (!f) return;
    if (f.points.length === 1) {
      const [lat, lon] = f.points[0];
      state.map.setView([lat, lon], 18);
      const m = f.id && state.markers.get(f.id);
      if (m) m.openPopup();
      else L.popup().setLatLng([lat, lon]).setContent(placePopup(f.label, "", lat, lon)).openOn(state.map);
    } else {
      state.map.fitBounds(f.points, { padding: [40, 40], maxZoom: 17 });
      const [lat, lon] = f.points[0];
      L.popup().setLatLng(f.points[0]).setContent(placePopup(f.label, "", lat, lon)).openOn(state.map);
    }
  }

  // ---- « Y aller » : ouvre le GPS du téléphone vers une adresse ----------------------

  const UA = navigator.userAgent;
  const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const IS_ANDROID = /Android/.test(UA);

  function navLinks(lat, lon, label) {
    const ll = `${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
    const google = `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`;
    const waze = `https://waze.com/ul?ll=${ll}&navigate=yes`;
    const apple = `https://maps.apple.com/?daddr=${ll}&dirflg=d`;
    // Android : « geo: » propose toutes les applis de navigation installées
    const main = IS_IOS ? apple : IS_ANDROID ? `geo:${ll}?q=${ll}(${encodeURIComponent(label)})` : google;
    return { main, others: main === google ? [["Waze", waze]] : [["Google Maps", google], ["Waze", waze]] };
  }

  function placePopup(label, detail, lat, lon) {
    const nav = navLinks(lat, lon, label);
    const target = nav.main.startsWith("geo:") ? "" : ' target="_blank" rel="noopener"';
    return `<div class="place-popup">
      <strong>${escapeHtml(label)}</strong>${detail ? `<span class="place-detail">${escapeHtml(detail)}</span>` : ""}
      <a class="btn small primary nav-go" href="${escapeHtml(nav.main)}"${target}>
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l18-8-8 18-2-8z" /></svg>Y aller</a>
      <span class="nav-alt">ou avec ${nav.others.map(([n, u]) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener">${n}</a>`).join(" · ")}</span>
    </div>`;
  }

  /** Les points d'adresse sont petits : un appui à côté ouvre l'adresse la plus proche. */
  function nearestAddressMarker(latlng, maxPx) {
    if (!state.current) return null;
    const p = state.map.latLngToContainerPoint(latlng);
    let best = null;
    let bestD = maxPx;
    for (const m of state.markers.values()) {
      const d = p.distanceTo(state.map.latLngToContainerPoint(m.getLatLng()));
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  // ne pas écraser className : Leaflet y a mis ses propres classes (leaflet-container…)
  function setMapMode(mode) {
    els.mapEl.classList.toggle("map-home", mode === "map-home");
    els.mapEl.classList.toggle("map-sector", mode === "map-sector");
  }

  // ---- Téléphone : feuille du bas qu'on glisse (repliée / mi-hauteur / plein écran) ---

  const PANEL_KEY = "panneau-replie"; // "1" repliée, "0" mi-hauteur, "2" plein écran
  const SHEET_STATES = ["collapsed", "half", "full"]; // de la plus basse à la plus haute
  const mobileQuery = window.matchMedia("(max-width: 899px)");
  const drawer = document.getElementById("drawer");
  const handle = document.getElementById("panel-handle");
  let sheet = { 1: "collapsed", 2: "full" }[storage.get(PANEL_KEY, "0")] || "half";

  /** Titre de secteur sans répéter le code quand le nom le contient déjà (« B1 - Le bourg »). */
  function sectorTitle() {
    const code = els.code.textContent;
    const name = els.name.textContent;
    return name.toUpperCase().startsWith(code.toUpperCase()) ? name : `${code} · ${name}`;
  }

  function updateHandle() {
    const collapsed = sheet === "collapsed";
    const text = !collapsed
      ? "Replier pour agrandir la carte"
      : state.current
        ? `${sectorTitle()} — détails`
        : "Afficher la liste des secteurs";
    els.panelToggle.innerHTML = `<span class="toggle-text">${escapeHtml(text)}</span>`;
    els.panelToggle.setAttribute("aria-expanded", String(!collapsed));
    els.handleBack.hidden = !(collapsed && state.current);
  }

  /** Hauteurs (px) de la feuille dans chaque position. */
  function sheetHeights() {
    const total = drawer.parentElement.clientHeight;
    const pad = parseFloat(getComputedStyle(drawer).paddingBottom) || 0;
    const collapsed = handle.offsetHeight + pad;
    return {
      collapsed,
      half: Math.max(collapsed, Math.round(total * 0.56)),
      full: Math.max(collapsed, Math.round(total * 0.9)),
    };
  }

  function applySheet() {
    document.body.classList.toggle("panel-collapsed", sheet === "collapsed");
    document.body.classList.toggle("panel-full", sheet === "full");
    drawer.style.height = mobileQuery.matches ? `${sheetHeights()[sheet]}px` : "";
    updateHandle();
  }

  function setSheet(next) {
    sheet = next;
    storage.set(PANEL_KEY, next === "collapsed" ? "1" : next === "full" ? "2" : "0");
    applySheet();
    // la carte change de taille pendant l'animation de la feuille
    setTimeout(() => state.map && state.map.invalidateSize(), 300);
  }

  // glisser la petite barre (ou le bouton) vers le haut ou le bas
  let drag = null;
  let suppressClick = false;
  handle.addEventListener("pointerdown", (e) => {
    if (!mobileQuery.matches || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag = { id: e.pointerId, y: e.clientY, h: drawer.getBoundingClientRect().height, from: sheet, moved: false, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dy) < 6) return; // simple appui : c'est un clic
      drag.moved = true;
      document.body.classList.add("sheet-dragging");
      document.body.classList.remove("panel-collapsed"); // le contenu apparaît pendant le geste
    }
    const { collapsed, full } = sheetHeights();
    drawer.style.height = `${Math.min(full, Math.max(collapsed, drag.h - dy))}px`;
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.v = 0.6 * ((e.clientY - drag.lastY) / dt) + 0.4 * drag.v; // px/ms, positif vers le bas
    drag.lastY = e.clientY;
    drag.lastT = e.timeStamp;
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    document.body.classList.remove("sheet-dragging");
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 50);
    const h = drawer.getBoundingClientRect().height;
    const heights = sheetHeights();
    const step = (dir) => SHEET_STATES[Math.max(0, Math.min(SHEET_STATES.length - 1, SHEET_STATES.indexOf(d.from) + dir))];
    let next;
    if (Math.abs(d.v) > 0.5) {
      next = step(d.v < 0 ? 1 : -1); // geste rapide : une position dans le sens du geste
    } else {
      // geste lent : la position la plus proche de là où on a lâché
      next = SHEET_STATES.reduce((best, st) => (Math.abs(heights[st] - h) < Math.abs(heights[best] - h) ? st : best));
      if (next === d.from && Math.abs(h - d.h) > 40) next = step(h > d.h ? 1 : -1);
    }
    setSheet(next);
  };
  // suivi sur toute la fenêtre : le doigt (ou la souris) sort vite de la petite barre
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  // après un glissé, le relâchement ne doit pas compter comme un clic sur les boutons
  handle.addEventListener("click", (e) => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  els.panelToggle.addEventListener("click", () => setSheet(sheet === "collapsed" ? "half" : "collapsed"));
  els.handleBack.addEventListener("click", () => { location.hash = "#/"; });
  window.addEventListener("resize", applySheet);
  mobileQuery.addEventListener?.("change", applySheet);
  applySheet();

  function refreshMapSize(then) {
    setTimeout(() => { state.map.invalidateSize(); then(); }, 60);
  }

  function countsOf(sector) {
    const c = { fait: 0, absent: 0, refus: 0, a_faire: 0 };
    for (const a of sector.addresses) c[a.status || "a_faire"]++;
    return c;
  }

  function renderProgress(sector) {
    const c = countsOf(sector);
    const total = sector.addresses.length || 1;
    els.progress.innerHTML = ["fait", "absent", "refus"]
      .map((k) => `<span class="${k}" style="width:${(c[k] / total) * 100}%"></span>`).join("");
    els.stats.textContent = `${c.fait} fait · ${c.absent} absent · ${c.refus} refus · ${c.a_faire} restant sur ${sector.addresses.length}`;
  }

  function numericCompare(a, b) {
    return String(a || "").localeCompare(String(b || ""), "fr", { numeric: true });
  }

  function renderAddressList(slug, sector) {
    els.list.innerHTML = "";
    const groups = new Map();
    for (const a of sector.addresses) {
      if (!groups.has(a.groupe)) groups.set(a.groupe, []);
      groups.get(a.groupe).push(a);
    }
    const ordered = [...groups.entries()].sort((x, y) => y[1].length - x[1].length);
    for (const [name, addrs] of ordered) {
      const block = document.createElement("div");
      block.className = "address-group";
      block.innerHTML = `<h3 class="group-title">${escapeHtml(name)} <small>(${addrs.length})</small></h3>`;
      addrs.sort((x, y) => numericCompare(x.nom_voie, y.nom_voie) || numericCompare(x.numero, y.numero))
        .forEach((a) => block.appendChild(addressRow(slug, sector, a)));
      els.list.appendChild(block);
    }
    if (!sector.addresses.length) {
      els.list.innerHTML = `<p class="empty">Aucune adresse dans ce secteur.</p>`;
    }
  }

  function addressRow(slug, sector, a) {
    const row = document.createElement("div");
    row.className = "address-row";
    row.id = `addr-${CSS.escape(a.id)}`;
    applyRowStatus(row, a.status);

    const label = document.createElement("button");
    label.type = "button";
    label.className = "address-label";
    label.textContent = a.label;
    label.addEventListener("click", () => {
      const m = state.markers.get(a.id);
      if (!m) return;
      state.map.setView(m.getLatLng(), Math.max(state.map.getZoom(), 17));
      m.openPopup();
      els.mapEl.scrollIntoView({ behavior: "smooth" });
    });

    const buttons = document.createElement("div");
    buttons.className = "status-buttons";
    for (const key of Object.keys(STATUS)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "status-btn";
      b.dataset.status = key;
      b.title = STATUS[key].label;
      b.setAttribute("aria-label", `${STATUS[key].label} : ${a.label}`);
      b.textContent = STATUS[key].icon;
      b.classList.toggle("active", a.status === key);
      b.addEventListener("click", () => toggleStatus(slug, sector, a, key, row));
      buttons.appendChild(b);
    }
    const t = state.tracking;
    if (t && t.donsActive) {
      const don = document.createElement("button");
      don.type = "button";
      don.className = "status-btn don-btn";
      don.title = "Enregistrer un don";
      don.setAttribute("aria-label", `Don : ${a.label}`);
      don.textContent = "€";
      don.addEventListener("click", () => openDon(slug, sector, a));
      buttons.appendChild(don);
    }
    const main = document.createElement("div");
    main.className = "address-main";
    main.appendChild(label);
    const badges = donBadges(a.id);
    if (badges) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "don-badges";
      b.innerHTML = badges;
      b.addEventListener("click", () => openDon(slug, sector, a));
      main.appendChild(b);
    }
    row.append(main, buttons);
    return row;
  }

  function applyRowStatus(row, status) {
    row.className = `address-row${status ? ` status-${status}` : ""}`;
    row.dataset.done = status ? "1" : "0";
    row.querySelectorAll(".status-btn").forEach((b) => b.classList.toggle("active", b.dataset.status === status));
  }

  async function toggleStatus(slug, sector, a, key, row) {
    const newStatus = a.status === key ? null : key;
    a.status = newStatus;
    applyRowStatus(row, newStatus);
    state.markers.get(a.id)?.setStyle({ fillColor: statusColor(newStatus) });
    renderProgress(sector);
    try {
      await sendStatus(slug, a.id, newStatus);
    } catch (err) {
      if ([401, 403, 404].includes(err.status)) { showToast(err.message, true); return; }
      const q = readQueue();
      q.push({ slug, addressId: a.id, status: newStatus });
      writeQueue(q);
      showToast("Pas de réseau : enregistré sur le téléphone, envoi automatique au retour du réseau.", true);
    }
  }

  function highlightRow(id) {
    const row = document.getElementById(`addr-${CSS.escape(id)}`);
    if (!row) return;
    if (row.dataset.done === "1" && els.hideDone.checked) {
      els.hideDone.checked = false;
      els.list.classList.remove("hide-done");
    }
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("flash");
    setTimeout(() => row.classList.remove("flash"), 1500);
  }

  els.hideDone.addEventListener("change", () => els.list.classList.toggle("hide-done", els.hideDone.checked));

  els.back.addEventListener("click", () => { location.hash = "#/"; });

  els.share.addEventListener("click", async () => {
    const url = location.href;
    const title = `Secteur ${state.current?.sector.nom || ""} — calendriers des pompiers`;
    try {
      if (navigator.share) { await navigator.share({ title, url }); return; }
      await navigator.clipboard.writeText(url);
      showToast("Lien du secteur copié ✓");
    } catch (err) {
      if (err && err.name === "AbortError") return;
      window.prompt("Copiez ce lien :", url);
    }
  });

  // ---- Navigation ------------------------------------------------------------------

  async function loadAll() {
    const results = await Promise.allSettled(
      state.communes.map((c) => fetchJSON(`/api/communes/${encodeURIComponent(c.slug)}`)),
    );
    let loaded = 0;
    results.forEach((r, i) => {
      // hors-ligne : on garde les données déjà affichées
      if (r.status === "fulfilled") { state.all[state.communes[i].slug] = r.value; loaded++; }
    });
    if (!loaded && !Object.keys(state.all).length) throw new Error("données indisponibles");
    const any = Object.values(state.all)[0];
    state.suivi = Boolean(any && any.suivi);
    state.dons = Boolean(any && any.dons);
    for (const c of state.communes) {
      const d = state.all[c.slug];
      if (d) d.sectors.forEach((s, i) => { s.code = sectorCode(d.commune.nom, i); });
    }
    buildSearchIndex();
    renderTeamAccess();
  }

  // ---- Recherche d'adresse / rue / hameau -------------------------------------------

  function buildSearchIndex() {
    const index = [];
    for (const { slug, sector } of allSectors()) {
      const commune = state.all[slug].commune.nom;
      const where = `${commune} · ${sector.code} ${sector.nom}`;
      const groups = new Map();
      const voies = new Map();
      for (const a of sector.addresses) {
        index.push({ kind: "adresse", label: a.label, where, slug, sector, id: a.id, points: [[a.lat, a.lon]], norm: normalizeText(`${a.label} ${a.groupe} ${commune}`) });
        if (!groups.has(a.groupe)) groups.set(a.groupe, []);
        groups.get(a.groupe).push([a.lat, a.lon]);
        if (a.nom_voie) {
          if (!voies.has(a.nom_voie)) voies.set(a.nom_voie, []);
          voies.get(a.nom_voie).push([a.lat, a.lon]);
        }
      }
      const e = sector.equipe;
      if (e) {
        for (const [role, list] of [["Responsable", e.responsables], ["Équipier", e.equipiers]]) {
          for (const p of list) {
            index.push({ kind: "personne", label: p.nom, where: `${role} · ${where}`, slug, sector, points: [], norm: normalizeText(p.nom) });
          }
        }
      }
      groups.forEach((points, name) => index.push({ kind: "hameau", label: name, where, slug, sector, points, norm: normalizeText(`${name} ${commune}`) }));
      voies.forEach((points, name) => index.push({ kind: "rue", label: name, where, slug, sector, points, norm: normalizeText(`${name} ${commune}`) }));
    }
    state.searchIndex = index;
  }

  const KIND_ORDER = { personne: 0, hameau: 1, rue: 2, adresse: 3 };
  const KIND_LABEL = { personne: "Équipe", hameau: "Hameau", rue: "Rue", adresse: "Adresse" };

  function runSearch() {
    const tokens = normalizeText(els.search.value).split(" ").filter(Boolean);
    if (!tokens.length) { els.searchResults.hidden = true; return; }
    const results = state.searchIndex
      .filter((e) => tokens.every((t) => e.norm.includes(t)))
      .sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.label.localeCompare(y.label, "fr", { numeric: true }))
      .slice(0, 8);
    els.searchResults.innerHTML = "";
    if (!results.length) {
      els.searchResults.innerHTML = `<p class="hint search-empty">Aucun résultat dans les secteurs.</p>`;
    }
    for (const r of results) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "search-result";
      b.innerHTML = `<span class="search-kind">${KIND_LABEL[r.kind]}</span> <strong>${escapeHtml(r.label)}</strong>
        <span class="search-where"><b class="sector-code" style="background:${r.sector.couleur}">${escapeHtml(r.sector.code)}</b> ${escapeHtml(r.where)}</span>`;
      b.addEventListener("click", () => {
        state.pendingFocus = r.points.length ? { id: r.id, label: r.label, points: r.points } : null;
        els.search.value = "";
        els.searchResults.hidden = true;
        openSector(r.slug, r.sector.id);
      });
      els.searchResults.appendChild(b);
    }
    els.searchResults.hidden = false;
  }

  els.search.addEventListener("input", runSearch);
  els.search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.searchResults.querySelector(".search-result")?.click();
    if (e.key === "Escape") { els.search.value = ""; els.searchResults.hidden = true; }
  });

  async function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const slug = parts[0] ? decodeURIComponent(parts[0]) : null;
    const id = parts[1] ? Number(parts[1]) : null;
    // rechargé à chaque navigation pour voir l'avancement des autres équipes
    await loadAll();
    const sector = slug && id !== null ? state.all[slug]?.sectors.find((s) => s.id === id) : null;
    if (sector) showSector(slug, sector); else showHome();
  }

  /** Lien personnel « …/#acces=CODE » : connexion puis le code disparaît de l'adresse. */
  async function useAccessLink() {
    const acces = /[#&]acces=([A-Za-z0-9-]+)/.exec(location.hash);
    if (!acces) return false;
    history.replaceState(null, "", `${location.pathname}#/`);
    await fetchJSON("/api/equipe/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: acces[1] }),
    }).then((r) => showToast(`Bonjour ${r.nom} 👋 Votre accès est enregistré sur ce téléphone.`))
      .catch((err) => showToast(`Lien d'accès refusé : ${err.message}`, true));
    return true;
  }

  window.addEventListener("hashchange", async () => {
    if (await useAccessLink()) await loadMe();
    route().catch(onError);
  });
  window.addEventListener("beforeprint", () => state.map && state.map.invalidateSize());

  function onError(err) {
    console.error(err);
    showToast(`Erreur de chargement des données : ${err.message}`, true);
  }

  async function init() {
    initMap();
    await useAccessLink();
    await loadMe();
    const index = await fetchJSON("/api/communes");
    const { communes } = index;
    state.annee = index.annee;
    state.communes = communes;
    document.getElementById("communes-names").textContent = communes.map((c) => c.nom).join(" · ");
    if (index.annee) {
      document.getElementById("brand-title").textContent = tourneeTitle(index.annee);
      document.title = `${tourneeTitle(index.annee)} — Sapeurs-pompiers de Courzieu`;
    }
    if (!communes.length) {
      els.noSectors.hidden = false;
      els.noSectors.textContent = "Aucune donnée disponible pour l'instant.";
      return;
    }
    await route();
    flushQueue();
  }

  // ---- Espace équipe : code personnel, suivi réservé à l'équipe du secteur, dons -------

  const MODE_LABEL = { especes: "espèces", cheque: "chèque", cb: "carte" };
  const euros = (v) => `${Number(v).toLocaleString("fr-FR", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })} €`;
  const codeDialog = document.getElementById("code-dialog");
  const donDialog = document.getElementById("don-dialog");

  function canTrack(sector) {
    const me = state.me;
    return !!(state.suivi && me && me.suivi && (me.admin || me.roles.has(sector.id)));
  }

  async function loadMe() {
    try {
      const me = await fetchJSON("/api/equipe/moi");
      state.me = { ...me, roles: new Map(me.secteurs.map((x) => [x.sector_id, x.role])) };
    } catch {
      state.me = null;
    }
    renderTeamAccess();
  }

  function myCodes() {
    if (!state.me) return [];
    return allSectors().filter(({ sector }) => state.me.roles.has(sector.id));
  }

  function renderTeamAccess() {
    const box = document.getElementById("team-access");
    if (!state.suivi && !state.me) { box.hidden = true; return; }
    box.hidden = false;
    if (!state.me) {
      box.innerHTML = `<div class="team-access-text"><strong>🔒 Espace équipe</strong>
          <span>Suivi des maisons${state.dons ? " et des dons" : ""} avec votre code personnel.</span></div>
        <button type="button" class="btn small primary" data-action="login">Entrer mon code</button>`;
      return;
    }
    const who = state.me.admin && !state.me.personne ? "Administrateur" : escapeHtml(state.me.personne.nom);
    const mine = myCodes().map(({ slug, sector }) => `<button type="button" class="sector-code mine-code" style="background:${sector.couleur}" data-open="${escapeHtml(slug)}/${sector.id}" title="${escapeHtml(sector.nom)}">${state.me.roles.get(sector.id) === "responsable" ? "★ " : ""}${escapeHtml(sector.code)}</button>`).join("");
    box.innerHTML = `<div class="team-access-text"><strong>${who}</strong>
        <span>${state.me.admin ? "Accès à tous les secteurs" : mine ? `Mes secteurs : <span class="mine-codes">${mine}</span>` : "Pas encore placé(e) dans une équipe"}</span></div>
      <button type="button" class="btn small" data-action="logout">Déconnexion</button>`;
  }

  document.getElementById("team-access").addEventListener("click", async (e) => {
    const open = e.target.closest("[data-open]");
    if (open) { const [slug, id] = open.dataset.open.split("/"); openSector(slug, Number(id)); return; }
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "login") openCodeDialog();
    if (action === "logout") {
      await fetchJSON("/api/equipe/logout", { method: "POST" }).catch(() => {});
      state.me = null;
      await route();
      showToast("Déconnecté.");
    }
  });

  function openCodeDialog() {
    document.getElementById("code-error").hidden = true;
    document.getElementById("code-input").value = "";
    codeDialog.showModal();
    document.getElementById("code-input").focus();
  }

  async function login(code) {
    const res = await fetchJSON("/api/equipe/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
    await loadMe();
    await route();
    showToast(`Bonjour ${res.nom} 👋`);
  }

  document.getElementById("code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("code-error");
    try {
      await login(document.getElementById("code-input").value);
      codeDialog.close();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

  /** Suivi activé mais secteur d'une autre équipe (ou pas connecté). */
  function renderLocked(sector) {
    const box = document.getElementById("suivi-locked");
    box.hidden = !state.suivi || canTrack(sector);
    if (box.hidden) return;
    box.innerHTML = state.me
      ? `<p class="hint">Le suivi de ce secteur est réservé à son équipe.</p>`
      : `<p class="hint">🔒 Le suivi des maisons${state.dons ? " et des dons" : ""} est réservé à l'équipe du secteur.</p>
         <button type="button" class="btn small primary">Entrer mon code</button>`;
    box.querySelector("button")?.addEventListener("click", openCodeDialog);
  }

  async function loadTracking(slug, sector) {
    const t = await fetchJSON(`/api/equipe/secteurs/${sector.id}/suivi`);
    if (!state.current || state.current.sector !== sector) return; // secteur quitté entre-temps
    for (const a of sector.addresses) a.status = (t.statuses[a.id] || {}).status || null;
    const dons = new Map();
    for (const d of t.dons || []) {
      if (!dons.has(d.address_id)) dons.set(d.address_id, []);
      dons.get(d.address_id).push(d);
    }
    state.tracking = {
      sectorId: sector.id, slug, role: t.role, full: t.role !== "equipier", donsActive: t.dons !== null, dons, totaux: t.totaux,
    };
    for (const a of sector.addresses) state.markers.get(a.id)?.setStyle({ fillColor: statusColor(a.status) });
    els.suiviBlock.hidden = false;
    renderProgress(sector);
    renderTotaux();
    renderAddressList(slug, sector);
  }

  function onTrackingError(err) {
    if (err.status === 401) { state.me = null; renderTeamAccess(); }
    showToast(`Suivi indisponible : ${err.message}`, true);
  }

  function renderTotaux() {
    const box = document.getElementById("dons-totaux");
    const t = state.tracking;
    box.hidden = !(t && t.donsActive && t.totaux);
    if (box.hidden) return;
    const x = t.totaux;
    box.innerHTML = `<div class="total-main"><span>Total du secteur</span><strong>${euros(x.total)}</strong><small>${x.nb} don${x.nb > 1 ? "s" : ""}</small></div>
      <div class="total-modes"><span>Espèces <b>${euros(x.especes)}</b></span><span>Chèques <b>${euros(x.cheque)}</b></span><span>Carte <b>${euros(x.cb)}</b></span></div>
      ${x.attente ? `<p class="total-wait">⏳ ${x.attente} paiement${x.attente > 1 ? "s" : ""} carte en attente de confirmation</p>` : ""}`;
  }

  function donBadges(addressId) {
    const list = state.tracking && state.tracking.dons.get(addressId);
    if (!list || !list.length) return "";
    return list.map((d) => {
      const amount = d.montant !== undefined ? euros(d.montant) : "Don";
      const cls = d.statut === "ok" ? "ok" : d.statut === "attente" ? "wait" : "fail";
      const tail = d.statut === "attente" ? " · en attente" : d.statut === "echec" ? " · échoué" : "";
      return `<span class="don-badge ${cls}">${amount} ${MODE_LABEL[d.mode]}${tail}</span>`;
    }).join("");
  }

  // ---- Fenêtre « don » ----

  let donCtx = null;

  function sumupReady() {
    return !!(state.me && state.me.sumup && state.me.sumup.affiliate_key);
  }

  function selectedMode() {
    return donDialog.querySelector('input[name="mode"]:checked').value;
  }

  function refreshDonDialog() {
    const cb = selectedMode() === "cb";
    const sumup = cb && sumupReady();
    const manual = donCtx.manual || (cb && !sumupReady());
    document.getElementById("don-sumup").hidden = !sumup || donCtx.manual;
    document.getElementById("don-save").hidden = sumup && !donCtx.manual;
    document.getElementById("don-manual-toggle").hidden = !sumup || donCtx.manual;
    document.getElementById("don-cb-manual").hidden = !(cb && manual);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    document.getElementById("don-ios-hint").hidden = !(sumup && !donCtx.manual && IS_IOS && standalone);
  }

  function renderExistingDons() {
    const box = document.getElementById("don-existing");
    const list = (state.tracking.dons.get(donCtx.a.id) || []);
    const t = state.tracking;
    box.innerHTML = list.map((d) => {
      const canEdit = t.full || d.mine;
      const amount = d.montant !== undefined ? euros(d.montant) : "Don";
      const st = d.statut === "ok" ? "✓" : d.statut === "attente" ? "⏳ en attente" : "✕ échoué";
      return `<div class="don-line" data-id="${d.id}">
        <span><b>${amount}</b> ${MODE_LABEL[d.mode]} ${st}<small>${escapeHtml(d.personne_nom)}${d.tx_code ? ` · ${escapeHtml(d.tx_code)}` : ""}</small></span>
        ${canEdit ? `<span class="don-line-actions">
          ${d.statut === "attente" ? `<button type="button" class="btn small" data-act="ok">Payé</button><button type="button" class="btn small" data-act="echec">Non payé</button>` : ""}
          <button type="button" class="icon-btn danger" data-act="delete" title="Supprimer" aria-label="Supprimer ce don">✕</button></span>` : ""}
      </div>`;
    }).join("");
  }

  function openDon(slug, sector, a) {
    donCtx = { slug, sector, a, manual: false };
    document.getElementById("don-title").textContent = "Don";
    document.getElementById("don-address").textContent = a.label;
    document.getElementById("don-montant").value = "";
    document.getElementById("don-tx").value = "";
    document.getElementById("don-error").hidden = true;
    donDialog.querySelector('input[name="mode"][value="especes"]').checked = true;
    renderExistingDons();
    refreshDonDialog();
    donDialog.showModal();
  }

  donDialog.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", refreshDonDialog));
  donDialog.querySelector(".amount-chips").addEventListener("click", (e) => {
    const v = e.target.dataset.amount;
    if (v) document.getElementById("don-montant").value = v;
  });
  document.getElementById("don-manual-toggle").addEventListener("click", () => { donCtx.manual = true; refreshDonDialog(); });

  function readAmount() {
    const v = Number(document.getElementById("don-montant").value.replace(",", ".").replace(/[^0-9.]/g, ""));
    if (!(v > 0 && v <= 1000)) throw new Error("Indiquez un montant (entre 0 et 1000 €).");
    return Math.round(v * 100) / 100;
  }

  async function postDon(sumup) {
    const montant = readAmount();
    return fetchJSON("/api/equipe/dons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: donCtx.slug, address_id: donCtx.a.id, montant, mode: selectedMode(), sumup,
        tx_code: document.getElementById("don-tx").value,
      }),
    });
  }

  function donError(err) {
    const box = document.getElementById("don-error");
    box.textContent = err.message;
    box.hidden = false;
  }

  document.getElementById("don-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await postDon(false);
      donDialog.close();
      showToast("Don enregistré ✓");
      await loadTracking(donCtx.slug, donCtx.sector);
    } catch (err) {
      donError(err);
    }
  });

  /** Ouvre une autre appli (SumUp) ; remplaçable dans les tests. */
  function openExternal(url) {
    if (typeof window.__openExternal === "function") window.__openExternal(url);
    else location.href = url;
  }

  /** Ouvre l'appli SumUp avec le montant ; elle revient sur /sumup-retour/<id> une fois payé. */
  function sumupUrl(cfg, don) {
    const amount = don.montant.toFixed(2);
    const back = `${location.origin}/sumup-retour/${don.foreign_id}`;
    const params = {
      "affiliate-key": cfg.affiliate_key,
      total: amount,
      amount, // anciennes versions de l'appli
      currency: "EUR",
      title: `Calendrier ${state.annee || ""}`.trim(),
      "foreign-tx-id": don.foreign_id,
      callback: back, // Android
      callbacksuccess: back, // iPhone
      callbackfail: back,
    };
    if (cfg.app_id) params["app-id"] = cfg.app_id;
    return `sumupmerchant://pay/1.0?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
  }

  document.getElementById("don-sumup").addEventListener("click", async () => {
    try {
      const don = await postDon(true);
      storage.set("sumup-en-cours", JSON.stringify({ id: don.id, slug: donCtx.slug, sector: donCtx.sector.id }));
      donDialog.close();
      showToast("Ouverture de SumUp…");
      openExternal(sumupUrl(state.me.sumup, don));
      // si l'appli SumUp n'est pas installée, rien ne se passe : le don reste « en attente »
      setTimeout(() => loadTracking(donCtx.slug, donCtx.sector).catch(() => {}), 2500);
    } catch (err) {
      donError(err);
    }
  });

  document.getElementById("don-existing").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.closest(".don-line").dataset.id;
    try {
      if (btn.dataset.act === "delete") {
        if (!confirm("Supprimer ce don ?")) return;
        await fetchJSON(`/api/equipe/dons/${id}`, { method: "DELETE" });
      } else {
        const tx = btn.dataset.act === "ok" ? (prompt("N° de transaction SumUp (facultatif) :") || "") : "";
        await fetchJSON(`/api/equipe/dons/${id}/statut`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ statut: btn.dataset.act, tx_code: tx }),
        });
      }
      await loadTracking(donCtx.slug, donCtx.sector);
      renderExistingDons();
    } catch (err) {
      donError(err);
    }
  });

  // retour sur l'appli après un paiement SumUp, et toutes les minutes : suivi à jour
  // (les autres membres de l'équipe marquent des maisons en même temps)
  function refreshTracking() {
    if (document.visibilityState !== "visible" || !state.current || !state.tracking) return;
    if (donDialog.open) return; // pas pendant une saisie
    loadTracking(state.current.slug, state.current.sector).catch(() => {});
  }
  document.addEventListener("visibilitychange", refreshTracking);
  setInterval(refreshTracking, 60000);

  // ---- Installer l'application (écran d'accueil) ------------------------------------

  const install = {
    card: document.getElementById("install-card"),
    link: document.getElementById("btn-install-link"),
    dialog: document.getElementById("install-dialog"),
    steps: document.getElementById("install-steps"),
    prompt: null, // évènement « beforeinstallprompt » (Android / Chrome)
  };
  const INSTALL_KEY = "installer-masque";
  const SHARE_ICON = `<svg class="ico inline-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v13" /><path d="M7 8l5-5 5 5" /><path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6" /></svg>`;

  function isInstalled() {
    return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  }

  function refreshInstall() {
    const possible = !isInstalled() && (install.prompt || IS_IOS || IS_ANDROID);
    const dismissed = storage.get(INSTALL_KEY, "0") === "1";
    install.card.hidden = !possible || dismissed;
    install.link.hidden = !possible || !dismissed; // la carte masquée laisse un simple bouton en bas
  }

  async function startInstall() {
    if (install.prompt) {
      const ev = install.prompt;
      install.prompt = null;
      ev.prompt();
      const choice = await ev.userChoice.catch(() => null);
      if (choice && choice.outcome === "accepted") showToast("Application installée ✓");
      refreshInstall();
      return;
    }
    install.steps.innerHTML = IS_IOS
      ? `<li>Touchez le bouton <b>Partager</b> ${SHARE_ICON} (en bas dans Safari, en haut à droite dans Chrome).</li>
         <li>Faites défiler puis choisissez <b>« Sur l'écran d'accueil »</b>.</li>
         <li>Touchez <b>« Ajouter »</b> : l'écusson apparaît sur l'écran d'accueil.</li>`
      : `<li>Ouvrez le menu du navigateur <b>⋮</b> (en haut à droite).</li>
         <li>Choisissez <b>« Installer l'application »</b> ou <b>« Ajouter à l'écran d'accueil »</b>.</li>
         <li>Confirmez : l'écusson apparaît sur l'écran d'accueil.</li>`;
    if (install.dialog.showModal) install.dialog.showModal(); else install.dialog.setAttribute("open", "");
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // on garde la proposition pour notre bouton
    install.prompt = e;
    refreshInstall();
  });
  window.addEventListener("appinstalled", () => { install.prompt = null; refreshInstall(); });
  document.getElementById("btn-install").addEventListener("click", startInstall);
  install.link.addEventListener("click", startInstall);
  document.getElementById("install-close").addEventListener("click", () => {
    storage.set(INSTALL_KEY, "1");
    refreshInstall();
  });
  document.getElementById("install-ok").addEventListener("click", () => {
    if (install.dialog.close) install.dialog.close(); else install.dialog.removeAttribute("open");
  });
  install.dialog.addEventListener("click", (e) => { if (e.target === install.dialog) install.dialog.close(); });
  refreshInstall();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  init().catch(onError);
})();
