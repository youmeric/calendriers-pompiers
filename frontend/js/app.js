(() => {
  "use strict";

  const STATUS_LABELS = { fait: "Fait", absent: "Absent", refus: "Refus" };
  const STATUS_ICONS = { fait: "✓", absent: "⏳", refus: "✕" };
  const QUEUE_KEY = "pompiers-pending-updates";

  const state = {
    slug: localStorage.getItem("pompiers-last-commune") || null,
    data: null,
    map: null,
    layerGroup: null,
    markersById: new Map(),
  };

  const els = {
    select: document.getElementById("commune-select"),
    sectorsList: document.getElementById("sectors-list"),
    progress: document.getElementById("global-progress"),
    toggleMap: document.getElementById("toggle-map"),
    toast: document.getElementById("toast"),
  };

  function showToast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    els.toast.classList.toggle("error", isError);
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { els.toast.hidden = true; }, 2500);
  }

  // ---- File d'attente hors-ligne -----------------------------------------
  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
    catch { return []; }
  }
  function writeQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
  function queueUpdate(item) {
    const q = readQueue();
    q.push(item);
    writeQueue(q);
  }
  async function flushQueue() {
    const q = readQueue();
    if (!q.length) return;
    const remaining = [];
    for (const item of q) {
      try {
        await postStatus(item.slug, item.addressId, item.status, false);
      } catch {
        remaining.push(item);
      }
    }
    writeQueue(remaining);
    if (remaining.length === 0 && q.length > 0) showToast("Modifications hors-ligne synchronisées");
  }
  window.addEventListener("online", flushQueue);

  // ---- API -----------------------------------------------------------------
  async function fetchJSON(url, options) {
    const resp = await fetch(url, options);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  async function postStatus(slug, addressId, status, allowQueue = true) {
    const url = `/api/communes/${slug}/addresses/${encodeURIComponent(addressId)}/status`;
    try {
      return await fetchJSON(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
    } catch (err) {
      if (allowQueue) {
        queueUpdate({ slug, addressId, status });
        showToast("Hors-ligne : la modification sera synchronisée plus tard", true);
      }
      throw err;
    }
  }

  // ---- Rendu de la carte -----------------------------------------------------
  function initMap() {
    state.map = L.map("map", { zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>',
    }).addTo(state.map);
    state.layerGroup = L.layerGroup().addTo(state.map);
  }

  function statusColor(status) {
    switch (status) {
      case "fait": return "#2e9e5b";
      case "absent": return "#c9951d";
      case "refus": return "#c0392b";
      default: return "#3b4656";
    }
  }

  function renderMap(data) {
    state.layerGroup.clearLayers();
    state.markersById.clear();
    const bounds = [];

    if (data.commune.mairie) {
      const { lat, lon } = data.commune.mairie;
      L.marker([lat, lon], {
        icon: L.divIcon({ className: "mairie-icon", html: "🏛️", iconSize: [24, 24] }),
      }).bindPopup("Mairie").addTo(state.layerGroup);
      bounds.push([lat, lon]);
    }

    for (const sector of data.sectors) {
      if (sector.polygon && sector.polygon.length >= 3) {
        const latlngs = sector.polygon.map((p) => [p[0], p[1]]);
        const poly = L.polygon(latlngs, {
          color: sector.couleur,
          weight: 2,
          fillColor: sector.couleur,
          fillOpacity: 0.18,
        }).addTo(state.layerGroup);
        poly.bindTooltip(sector.nom, { sticky: true, className: "sector-tooltip" });
        latlngs.forEach((ll) => bounds.push(ll));
      }
      for (const addr of sector.addresses) {
        const marker = L.circleMarker([addr.lat, addr.lon], {
          radius: 5,
          color: "#ffffff",
          weight: 1,
          fillColor: statusColor(addr.status),
          fillOpacity: 0.95,
        });
        marker.bindPopup(`<strong>${escapeHtml(addr.label)}</strong><br>${escapeHtml(sector.nom)}`);
        marker.addTo(state.layerGroup);
        state.markersById.set(addr.id, marker);
        bounds.push([addr.lat, addr.lon]);
      }
    }

    if (bounds.length) state.map.fitBounds(bounds, { padding: [20, 20] });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---- Rendu de la liste ------------------------------------------------------
  function renderProgress(data) {
    const totals = { fait: 0, absent: 0, refus: 0, a_faire: 0 };
    for (const sector of data.sectors) {
      for (const key of Object.keys(totals)) totals[key] += sector.counts[key] || 0;
    }
    const total = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
    els.progress.innerHTML = "";
    for (const key of ["fait", "absent", "refus"]) {
      const span = document.createElement("span");
      span.className = key;
      span.style.width = `${(totals[key] / total) * 100}%`;
      span.title = `${STATUS_LABELS[key]}: ${totals[key]}`;
      els.progress.appendChild(span);
    }
    els.progress.setAttribute("aria-label",
      `Fait: ${totals.fait}, Absent: ${totals.absent}, Refus: ${totals.refus}, À faire: ${totals.a_faire}`);
  }

  function renderSectors(data) {
    els.sectorsList.innerHTML = "";
    data.sectors.forEach((sector, idx) => {
      const details = document.createElement("details");
      details.className = "sector-card";
      details.open = idx === 0;

      const summary = document.createElement("summary");
      summary.className = "sector-summary";
      summary.innerHTML = `
        <span class="color-dot" style="background:${sector.couleur}"></span>
        <span class="sector-title">
          <strong>${escapeHtml(sector.nom)}</strong>
          <small>${sector.addresses.length} adresses · ${sector.mode === "pied" ? "à pied" : "en voiture"} · ~${Math.round(sector.temps_estime_min)} min</small>
        </span>
        <span class="chip">${sector.counts.fait}/${sector.addresses.length} fait</span>
      `;
      details.appendChild(summary);

      const list = document.createElement("div");
      list.className = "address-list";
      sector.addresses
        .slice()
        .sort((a, b) => (a.nom_voie || a.lieu_dit).localeCompare(b.nom_voie || b.lieu_dit) || (a.numero || "").localeCompare(b.numero || "", undefined, { numeric: true }))
        .forEach((addr) => list.appendChild(renderAddressRow(data.commune.slug || state.slug, addr)));
      details.appendChild(list);

      els.sectorsList.appendChild(details);
    });
  }

  function renderAddressRow(slug, addr) {
    const row = document.createElement("div");
    row.className = `address-row status-${addr.status || ""}`;
    row.dataset.addressId = addr.id;

    const label = document.createElement("div");
    label.className = "address-label";
    label.innerHTML = `${escapeHtml(addr.label)}<span class="voie">${escapeHtml(addr.lieu_dit || addr.nom_voie || "")}</span>`;
    label.addEventListener("click", () => focusAddress(addr));
    row.appendChild(label);

    const buttons = document.createElement("div");
    buttons.className = "status-buttons";
    for (const key of ["fait", "absent", "refus"]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "status-btn";
      btn.dataset.status = key;
      btn.title = STATUS_LABELS[key];
      btn.textContent = STATUS_ICONS[key];
      btn.classList.toggle("active", addr.status === key);
      btn.addEventListener("click", () => toggleStatus(slug, addr, key, row));
      buttons.appendChild(btn);
    }
    row.appendChild(buttons);
    return row;
  }

  async function toggleStatus(slug, addr, key, row) {
    const newStatus = addr.status === key ? null : key;
    const previous = addr.status;
    addr.status = newStatus;

    row.className = `address-row status-${newStatus || ""}`;
    row.querySelectorAll(".status-btn").forEach((b) => b.classList.toggle("active", b.dataset.status === newStatus));

    const marker = state.markersById.get(addr.id);
    if (marker) marker.setStyle({ fillColor: statusColor(newStatus) });

    recomputeCountsAndRender();

    try {
      await postStatus(slug, addr.id, newStatus);
    } catch {
      addr.status = previous; // la mise à jour reste en file d'attente; on garde l'affichage optimiste
    }
  }

  function recomputeCountsAndRender() {
    for (const sector of state.data.sectors) {
      const counts = { fait: 0, absent: 0, refus: 0, a_faire: 0 };
      for (const addr of sector.addresses) counts[addr.status || "a_faire"]++;
      sector.counts = counts;
    }
    renderProgress(state.data);
    document.querySelectorAll(".sector-card .chip").forEach((chip, idx) => {
      const sector = state.data.sectors[idx];
      if (sector) chip.textContent = `${sector.counts.fait}/${sector.addresses.length} fait`;
    });
  }

  function focusAddress(addr) {
    const marker = state.markersById.get(addr.id);
    if (!marker) return;
    state.map.setView(marker.getLatLng(), Math.max(state.map.getZoom(), 17));
    marker.openPopup();
    document.getElementById("map").classList.remove("collapsed");
  }

  // ---- Chargement d'une commune --------------------------------------------
  async function loadCommune(slug) {
    state.slug = slug;
    localStorage.setItem("pompiers-last-commune", slug);
    const data = await fetchJSON(`/api/communes/${slug}`);
    data.commune.slug = slug;
    state.data = data;
    renderMap(data);
    renderProgress(data);
    renderSectors(data);
  }

  async function init() {
    initMap();
    const { communes } = await fetchJSON("/api/communes");
    els.select.innerHTML = communes.map((c) => `<option value="${c.slug}">${escapeHtml(c.nom)}</option>`).join("");
    const initial = communes.find((c) => c.slug === state.slug) ? state.slug : communes[0]?.slug;
    if (!initial) {
      showToast("Aucune commune disponible — lancez le pipeline de données", true);
      return;
    }
    els.select.value = initial;
    els.select.addEventListener("change", () => loadCommune(els.select.value));
    await loadCommune(initial);
    flushQueue();
  }

  els.toggleMap.addEventListener("click", () => {
    const mapEl = document.getElementById("map");
    if (mapEl.classList.contains("expanded")) {
      mapEl.classList.remove("expanded");
      els.toggleMap.textContent = "Réduire la carte";
    } else if (mapEl.classList.contains("collapsed")) {
      mapEl.classList.remove("collapsed");
      els.toggleMap.textContent = "Réduire la carte";
    } else {
      mapEl.classList.add("collapsed");
      els.toggleMap.textContent = "Agrandir la carte";
    }
    setTimeout(() => state.map && state.map.invalidateSize(), 220);
  });

  init().catch((err) => {
    console.error(err);
    showToast("Erreur de chargement des données", true);
  });
})();
