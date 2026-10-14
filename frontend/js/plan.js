(() => {
  "use strict";
  const { escapeHtml, fetchJSON, showToast, osmLayer, labelPoint, renderLimite, renderResume, hameauxPreview } = window.Common;

  const WORLD = [[85, -180], [85, 180], [-85, 180], [-85, -180]];
  const printBtn = document.getElementById("btn-print");

  function label(sector, small) {
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

  function enablePrint() {
    if (!printBtn.disabled) return;
    printBtn.disabled = false;
    printBtn.textContent = "🖨 Imprimer / PDF";
  }

  async function init() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const slug = parts[0] ? decodeURIComponent(parts[0]) : null;
    const sectorId = parts[1] ? Number(parts[1]) : null;
    if (!slug) throw new Error("Commune non précisée dans l'adresse de la page");

    const data = await fetchJSON(`/api/communes/${encodeURIComponent(slug)}`);
    const sector = sectorId !== null ? data.sectors.find((s) => s.id === sectorId) : null;
    if (sectorId !== null && !sector) throw new Error("Secteur introuvable (a-t-il été supprimé ?)");

    document.getElementById("plan-commune").textContent = data.commune.nom;
    document.getElementById("plan-date").textContent = `imprimé le ${new Date().toLocaleDateString("fr-FR")}`;
    document.body.classList.add(sector ? "plan-sector" : "plan-overview");

    const map = L.map("plan-map", { zoomControl: true, zoomSnap: 0.25 }).setView([45.742, 4.57], 13);
    const tiles = osmLayer().addTo(map);
    tiles.once("load", enablePrint);
    setTimeout(enablePrint, 8000);

    const bounds = L.latLngBounds([]);
    if (sector) {
      document.title = `Plan — ${sector.nom}`;
      document.getElementById("plan-title").textContent = sector.nom;
      document.getElementById("plan-subtitle").textContent = `${sector.addresses.length} adresses`;
      document.getElementById("plan-dot").style.background = sector.couleur;

      L.polygon([WORLD, sector.polygon], { stroke: false, fillColor: "#0b1220", fillOpacity: 0.45, interactive: false }).addTo(map);
      for (const other of data.sectors) {
        if (other.id === sector.id) continue;
        L.polygon(other.polygon, { color: other.couleur, weight: 1.5, dashArray: "4 4", fill: false, interactive: false }).addTo(map);
        label(other, true).addTo(map);
      }
      const outline = L.polygon(sector.polygon, { color: sector.couleur, weight: 5, fill: false, interactive: false }).addTo(map);
      for (const a of sector.addresses) {
        L.circleMarker([a.lat, a.lon], { radius: 3, color: "#fff", weight: 1, fillColor: "#3b4656", fillOpacity: 1, interactive: false }).addTo(map);
      }
      bounds.extend(outline.getBounds());

      document.getElementById("plan-limite-block").hidden = false;
      renderLimite(document.getElementById("plan-limite"), sector.limite);
      document.getElementById("plan-resume-block").hidden = false;
      renderResume(document.getElementById("plan-resume"), sector.resume);
    } else {
      document.title = `Plan des secteurs — ${data.commune.nom}`;
      document.getElementById("plan-title").textContent = `Plan des secteurs — ${data.commune.nom}`;
      document.getElementById("plan-subtitle").textContent = `${data.sectors.length} secteurs`;
      document.getElementById("plan-dot").hidden = true;

      const rows = [];
      for (const s of data.sectors) {
        const poly = L.polygon(s.polygon, { color: s.couleur, weight: 3, fillColor: s.couleur, fillOpacity: 0.25, interactive: false }).addTo(map);
        label(s, false).addTo(map);
        bounds.extend(poly.getBounds());
        rows.push(`<tr>
          <td><span class="color-dot" style="background:${s.couleur}"></span></td>
          <td><strong>${escapeHtml(s.nom)}</strong></td>
          <td>${s.addresses.length} adresses</td>
          <td class="hint">${escapeHtml(hameauxPreview(s.resume, 4))}</td>
        </tr>`);
      }
      document.getElementById("plan-legend").hidden = false;
      document.getElementById("plan-legend-body").innerHTML = rows.join("");
    }

    map.invalidateSize();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [15, 15] });
  }

  printBtn.addEventListener("click", () => window.print());

  init().catch((err) => {
    console.error(err);
    showToast(err.message, true);
    printBtn.textContent = "Erreur de chargement";
  });
})();
