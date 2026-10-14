/* Fonctions partagées par la page publique et la page admin. */
window.Common = (() => {
  "use strict";

  const PALETTE = ["#e6550d", "#31a354", "#3182bd", "#756bb1", "#d6336c", "#0c8599", "#e8a10c", "#5c7cfa"];

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  async function fetchJSON(url, options) {
    const resp = await fetch(url, { credentials: "same-origin", ...options });
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try { detail = (await resp.json()).detail || detail; } catch { /* corps non JSON */ }
      const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  function showToast(message, isError = false) {
    const el = document.getElementById("toast");
    el.textContent = message;
    el.hidden = false;
    el.classList.toggle("error", isError);
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { el.hidden = true; }, 3000);
  }

  /** ring = [[lat, lon], ...] */
  function pointInPolygon(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i];
      const [yj, xj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function depth(v) {
    let d = 0;
    while (Array.isArray(v) && v.length) { v = v[0]; d++; }
    return d;
  }

  /** Format canonique d'un secteur : [[contour, enclave, ...], ...] (morceaux avec enclaves),
      en [lat, lon]. Accepte aussi un contour seul ou une liste de contours (anciens formats). */
  function toPolys(polygon) {
    const d = depth(polygon);
    if (d === 2) return [[polygon]];
    if (d === 3) return polygon.map((ring) => [ring]);
    if (d === 4) return polygon;
    return [];
  }

  function pointInPolys(lat, lon, polys) {
    return polys.some((poly) => poly.length && pointInPolygon(lat, lon, poly[0])
      && !poly.slice(1).some((hole) => pointInPolygon(lat, lon, hole)));
  }

  function outerRings(polys) { return polys.map((p) => p[0]).filter(Boolean); }
  function holeRings(polys) { return polys.flatMap((p) => p.slice(1)); }

  function osmLayer() {
    return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>',
    });
  }

  // Fonds IGN de la Géoplateforme : libres, sans clé d'accès.
  function ignLayer(layer, format, maxNativeZoom) {
    return L.tileLayer(
      "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
      + `&LAYER=${layer}&STYLE=normal&FORMAT=${format}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`,
      { maxZoom: 19, maxNativeZoom, attribution: '&copy; <a href="https://www.ign.fr/">IGN</a> – Géoplateforme' },
    );
  }

  const BASE_KEY = "fond-de-carte";

  /** Ajoute les fonds de carte (OSM, plan IGN, photo aérienne) et un sélecteur ; mémorise le choix. */
  function addBaseLayers(map) {
    const layers = {
      "Plan OpenStreetMap": osmLayer(),
      "Plan IGN": ignLayer("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "image/png", 18),
      "Photo aérienne (IGN)": ignLayer("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg", 19),
    };
    let saved = null;
    try { saved = localStorage.getItem(BASE_KEY); } catch { /* indisponible */ }
    const current = layers[saved] || layers["Plan OpenStreetMap"];
    current.addTo(map);
    L.control.layers(layers, null, { position: "topright" }).addTo(map);
    map.on("baselayerchange", (e) => { try { localStorage.setItem(BASE_KEY, e.name); } catch { /* indisponible */ } });
    return current;
  }

  /** Code court d'un secteur pour les pastilles : initiale de la commune + rang (C1, B2…). */
  function sectorCode(communeNom, index) {
    return `${(communeNom || "?").trim().charAt(0).toUpperCase()}${index + 1}`;
  }

  /** Étiquette de secteur : pastille avec le code, puis le nom (masqué quand on est loin). */
  function labelHtml(sector, code) {
    return `<span class="sector-tag" style="border-color:${sector.couleur}">`
      + `<b class="sector-code" style="background:${sector.couleur}">${escapeHtml(code)}</b>`
      + `<span class="sector-name">${escapeHtml(sector.nom)}</span></span>`;
  }

  /** En dessous de ce zoom, seules les pastilles sont affichées (évite les noms qui se chevauchent). */
  function compactLabelsBelow(map, zoom) {
    const update = () => map.getContainer().classList.toggle("labels-compact", map.getZoom() < zoom);
    map.on("zoomend", update);
    update();
  }

  /** Distance (m) d'un point au bord le plus proche d'un secteur (contours et enclaves). */
  function distanceToEdge(lat, lon, polys) {
    const kx = 111320 * Math.cos((lat * Math.PI) / 180);
    const ky = 110540;
    let best = Infinity;
    for (const poly of polys) {
      for (const ring of poly) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const ax = (ring[j][1] - lon) * kx, ay = (ring[j][0] - lat) * ky;
          const bx = (ring[i][1] - lon) * kx, by = (ring[i][0] - lat) * ky;
          const dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
          best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
        }
      }
    }
    return best;
  }

  /** Texte comparable pour la recherche : minuscules, sans accents ni ponctuation. */
  function normalizeText(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").trim();
  }

  function labelPoint(sector, addresses) {
    const polys = toPolys(sector.polygon);
    if (addresses && addresses.length) {
      const lat = addresses.reduce((s, a) => s + a.lat, 0) / addresses.length;
      const lon = addresses.reduce((s, a) => s + a.lon, 0) / addresses.length;
      if (pointInPolys(lat, lon, polys)) return [lat, lon];
      // sinon : l'adresse la plus proche du centre de gravité, toujours dans le secteur
      let best = addresses[0];
      let bestD = Infinity;
      for (const a of addresses) {
        const d = (a.lat - lat) ** 2 + (a.lon - lon) ** 2;
        if (d < bestD) { bestD = d; best = a; }
      }
      return [best.lat, best.lon];
    }
    const outers = outerRings(polys);
    const largest = outers.reduce((big, r) => (r.length > big.length ? r : big), outers[0] || []);
    return L.latLngBounds(largest).getCenter();
  }

  function formatDistance(m) {
    if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
    return `${(m / 1000).toFixed(1).replace(".", ",")} km`;
  }

  function formatDuration(min) {
    const total = Math.round(min);
    if (total < 60) return `${total} min`;
    return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, "0")}`;
  }

  const OFF_ROAD = "hors route (à travers champs)";
  const PART_MARKER = "__partie__";
  const ENCLAVE_MARKER = "__enclave__";

  /** Description de la limite : liste ordonnée des routes suivies. */
  function renderLimite(container, limite) {
    if (!limite || !limite.length) {
      container.innerHTML = `<p class="hint">Description indisponible.</p>`;
      return;
    }
    // un secteur en plusieurs morceaux et/ou avec enclaves : une liste par contour
    const groups = [];
    for (const run of limite) {
      if (run.nom === PART_MARKER) groups.push({ titre: `Morceau ${run.partie}`, runs: [] });
      else if (run.nom === ENCLAVE_MARKER) groups.push({ titre: "Enclave (zone au milieu qui ne fait pas partie du secteur)", runs: [] });
      else {
        if (!groups.length) groups.push({ titre: null, runs: [] });
        groups[groups.length - 1].runs.push(run);
      }
    }
    const list = (runs) => `<ol class="limite-list">${runs.map((run) => {
      const what = run.nom === OFF_ROAD ? `à travers champs` : `<strong>${escapeHtml(run.nom)}</strong>`;
      const cross = run.croise && run.croise.length
        ? ` <span class="hint">— croise ${run.croise.map(escapeHtml).join(", ")}</span>` : "";
      return `<li>${what} sur ${formatDistance(run.m)}${cross}</li>`;
    }).join("")}</ol>`;
    const intro = `<p class="hint">En partant du point le plus au nord, dans le sens des aiguilles d'une montre, la limite suit :</p>`;
    if (groups.length === 1) {
      container.innerHTML = intro + list(groups[0].runs);
    } else {
      container.innerHTML = `<p class="hint">Pour chaque contour, en partant du point le plus au nord, dans le sens des aiguilles d'une montre :</p>`
        + groups.map((g) => `${g.titre ? `<p class="limite-part">${escapeHtml(g.titre)}</p>` : ""}${list(g.runs)}`).join("");
    }
  }

  function voieText(v) {
    let nums = "";
    if (v.min !== null && v.min !== undefined) {
      nums = v.min === v.max ? `n° ${v.min}` : `n° ${v.min} à ${v.max}`;
      if (v.cote) nums += `, côté ${v.cote}`;
    }
    const count = `${v.nb} adresse${v.nb > 1 ? "s" : ""}`;
    const partial = v.partiel ? ` <span class="badge">en partie</span>` : "";
    return `<span class="voie-nom">${escapeHtml(v.nom)}</span> <span class="voie-detail">${nums ? `${nums} · ` : ""}${count}</span>${partial}`;
  }

  /** Résumé : hameaux puis rues et numéros contenus dans le secteur. */
  function renderResume(container, resume) {
    if (!resume || !resume.length) {
      container.innerHTML = `<p class="hint">Aucune adresse dans ce secteur.</p>`;
      return;
    }
    container.innerHTML = resume.map((e) => `
      <div class="resume-entry">
        <h4>${escapeHtml(e.nom)} <small>${e.nb} adresse${e.nb > 1 ? "s" : ""}</small></h4>
        <ul>${e.voies.map((v) => `<li>${voieText(v)}</li>`).join("")}</ul>
      </div>`).join("");
  }

  function hameauxPreview(resume, max = 3) {
    const names = (resume || []).filter((e) => e.nom !== "Habitations isolées").map((e) => e.nom);
    return names.slice(0, max).join(", ") + (names.length > max ? "…" : "");
  }

  return {
    PALETTE, escapeHtml, fetchJSON, showToast, pointInPolygon, osmLayer, labelPoint,
    formatDistance, formatDuration, renderLimite, renderResume, hameauxPreview,
    toPolys, pointInPolys, outerRings, holeRings, OFF_ROAD,
    addBaseLayers, sectorCode, labelHtml, compactLabelsBelow, distanceToEdge, normalizeText,
  };
})();
