(() => {
  "use strict";
  const {
    escapeHtml, fetchJSON, showToast, osmLayer, labelPoint, renderLimite, renderResume, hameauxPreview,
    toPolys, outerRings, holeRings,
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
    dot: document.getElementById("sector-dot"),
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
  };

  const state = {
    communes: [], // [{slug, nom}] dans l'ordre de l'index
    all: {}, // slug -> données de la commune
    suivi: false,
    current: null, // {slug, sector}
    map: null,
    layer: null,
    markers: new Map(),
    locate: { active: false, marker: null, circle: null, centered: false },
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
        // 403 : suivi désactivé par l'admin, 404 : adresse disparue -> on abandonne
        if (err.status !== 403 && err.status !== 404) remaining.push(item);
      }
    }
    writeQueue(remaining);
    if (!remaining.length) showToast("Modifications hors-ligne synchronisées ✓");
  }
  window.addEventListener("online", flushQueue);

  // ---- Carte -----------------------------------------------------------------------

  function initMap() {
    state.map = L.map("map", { zoomControl: true, zoomSnap: 0.5 }).setView([45.742, 4.57], 13);
    osmLayer().addTo(state.map);
    state.layer = L.layerGroup().addTo(state.map);
    addLocateControl();
  }

  function addLocateControl() {
    const Locate = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const btn = L.DomUtil.create("button", "locate-btn leaflet-bar");
        btn.type = "button";
        btn.title = "Me localiser";
        btn.setAttribute("aria-label", "Me localiser");
        btn.textContent = "📍";
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
      if (!loc.centered) {
        loc.centered = true;
        state.map.setView(e.latlng, Math.max(state.map.getZoom(), 16));
      }
    });
    state.map.on("locationerror", () => {
      showToast("Position indisponible : autorisez la localisation pour ce site.", true);
      stopLocate();
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
    document.querySelector(".locate-btn")?.classList.remove("active");
  }

  function sectorLabel(sector, small) {
    return L.marker(labelPoint(sector, sector.addresses), {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: `sector-label-icon${small ? " small" : ""}`,
        html: `<span style="border-color:${sector.couleur}">${escapeHtml(sector.nom)}</span>`,
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
  }

  function sectorButton(slug, s) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sector-button";
    btn.style.borderLeftColor = s.couleur;
    let meta = `${s.addresses.length} adresses`;
    let progress = "";
    if (state.suivi && s.counts) {
      const total = s.addresses.length || 1;
      const done = s.counts.fait + s.counts.absent + s.counts.refus;
      meta += ` · ${Math.round((done / total) * 100)} % traité`;
      progress = `<span class="mini-progress"><span style="width:${(done / total) * 100}%;background:${s.couleur}"></span></span>`;
    } else {
      const preview = hameauxPreview(s.resume);
      if (preview) meta += ` · ${escapeHtml(preview)}`;
    }
    btn.innerHTML = `
      <span class="sector-button-name"><span class="color-dot" style="background:${s.couleur}"></span>${escapeHtml(s.nom)}</span>
      <span class="sector-button-meta">${meta}</span>${progress}`;
    btn.addEventListener("click", () => openSector(slug, s.id));
    return btn;
  }

  function openSector(slug, id) {
    location.hash = `#/${encodeURIComponent(slug)}/${id}`;
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
    const mask = { stroke: false, fillColor: "#0b1220", fillOpacity: 0.5, interactive: false };
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

    const suivi = state.suivi;
    for (const a of sector.addresses) {
      const m = L.circleMarker([a.lat, a.lon], {
        radius: suivi ? 6 : 4, color: "#fff", weight: 1.5, fillColor: suivi ? statusColor(a.status) : TODO_COLOR, fillOpacity: 1,
      });
      m.bindPopup(`<strong>${escapeHtml(a.label)}</strong><br>${escapeHtml(a.groupe)}`);
      if (suivi) m.on("click", () => highlightRow(a.id));
      m.addTo(state.layer);
      state.markers.set(a.id, m);
    }

    els.dot.style.background = sector.couleur;
    els.name.textContent = sector.nom;
    const communeNom = state.all[slug].commune.nom;
    els.summary.textContent = `${communeNom} · ${sector.addresses.length} adresses${polys.length > 1 ? ` · ${polys.length} morceaux` : ""}`;
    els.print.href = `plan.html#/${encodeURIComponent(slug)}/${sector.id}`;
    renderLimite(els.limite, sector.limite);
    renderResume(els.resume, sector.resume);
    els.suiviBlock.hidden = !suivi;
    if (suivi) {
      renderProgress(sector);
      renderAddressList(slug, sector);
    }
    window.scrollTo({ top: 0 });

    refreshMapSize(() => state.map.fitBounds(outline.getBounds(), { padding: [20, 20] }));
  }

  // ne pas écraser className : Leaflet y a mis ses propres classes (leaflet-container…)
  function setMapMode(mode) {
    els.mapEl.classList.toggle("map-home", mode === "map-home");
    els.mapEl.classList.toggle("map-sector", mode === "map-sector");
  }

  function refreshMapSize(then) {
    setTimeout(() => { state.map.invalidateSize(); then(); }, 60);
  }

  function renderProgress(sector) {
    const c = sector.counts;
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
    row.append(label, buttons);
    return row;
  }

  function applyRowStatus(row, status) {
    row.className = `address-row${status ? ` status-${status}` : ""}`;
    row.dataset.done = status ? "1" : "0";
    row.querySelectorAll(".status-btn").forEach((b) => b.classList.toggle("active", b.dataset.status === status));
  }

  async function toggleStatus(slug, sector, a, key, row) {
    const newStatus = a.status === key ? null : key;
    sector.counts[a.status || "a_faire"]--;
    sector.counts[newStatus || "a_faire"]++;
    a.status = newStatus;
    applyRowStatus(row, newStatus);
    state.markers.get(a.id)?.setStyle({ fillColor: statusColor(newStatus) });
    renderProgress(sector);
    try {
      await sendStatus(slug, a.id, newStatus);
    } catch {
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
  }

  async function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const slug = parts[0] ? decodeURIComponent(parts[0]) : null;
    const id = parts[1] ? Number(parts[1]) : null;
    // rechargé à chaque navigation pour voir l'avancement des autres équipes
    await loadAll();
    const sector = slug && id !== null ? state.all[slug]?.sectors.find((s) => s.id === id) : null;
    if (sector) showSector(slug, sector); else showHome();
  }

  window.addEventListener("hashchange", () => route().catch(onError));

  function onError(err) {
    console.error(err);
    showToast("Erreur de chargement des données", true);
  }

  async function init() {
    initMap();
    const { communes } = await fetchJSON("/api/communes");
    state.communes = communes;
    document.querySelector(".topbar-sub").textContent = communes.map((c) => c.nom).join(" · ");
    if (!communes.length) {
      els.noSectors.hidden = false;
      els.noSectors.textContent = "Aucune donnée disponible pour l'instant.";
      return;
    }
    await route();
    flushQueue();
  }

  init().catch(onError);
})();
