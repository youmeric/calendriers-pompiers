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

  return { PALETTE, escapeHtml, fetchJSON, showToast, pointInPolygon, osmLayer, labelPoint };
})();
