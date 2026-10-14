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

  function osmLayer() {
    return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>',
    });
  }

  function labelPoint(sector, addresses) {
    if (addresses && addresses.length) {
      const lat = addresses.reduce((s, a) => s + a.lat, 0) / addresses.length;
      const lon = addresses.reduce((s, a) => s + a.lon, 0) / addresses.length;
      if (pointInPolygon(lat, lon, sector.polygon)) return [lat, lon];
    }
    return L.latLngBounds(sector.polygon).getCenter();
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

  /** Description de la limite : liste ordonnée des routes suivies. */
  function renderLimite(container, limite) {
    if (!limite || !limite.length) {
      container.innerHTML = `<p class="hint">Description indisponible.</p>`;
      return;
    }
    const items = limite.map((run) => {
      const what = run.nom === OFF_ROAD
        ? `à travers champs`
        : `<strong>${escapeHtml(run.nom)}</strong>`;
      const cross = run.croise && run.croise.length
        ? ` <span class="hint">— croise ${run.croise.map(escapeHtml).join(", ")}</span>` : "";
      return `<li>${what} sur ${formatDistance(run.m)}${cross}</li>`;
    }).join("");
    container.innerHTML = `<p class="hint">En partant du point le plus au nord, dans le sens des aiguilles d'une montre, la limite suit :</p><ol class="limite-list">${items}</ol>`;
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
  };
})();
