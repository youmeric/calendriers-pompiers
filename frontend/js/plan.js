(() => {
  "use strict";
  const {
    escapeHtml, fetchJSON, showToast, osmLayer, labelPoint, renderLimite, renderResume, hameauxPreview,
    toPolys, outerRings, holeRings,
  } = window.Common;

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

  function contour(commune) {
    return commune.contour
      ? L.geoJSON(commune.contour, { style: { color: "#1c2430", weight: 2, dashArray: "8 6", fill: false, opacity: 0.6 }, interactive: false })
      : null;
  }

  function enablePrint() {
    if (!printBtn.disabled) return;
    printBtn.disabled = false;
    printBtn.textContent = "🖨 Imprimer / PDF";
  }

  async function init() {
    const hash = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const slug = hash[0] ? decodeURIComponent(hash[0]) : null;
    const sectorId = hash[1] ? Number(hash[1]) : null;

    // sans commune précisée : plan d'ensemble de toutes les communes
    const { communes } = await fetchJSON("/api/communes");
    const wanted = slug ? communes.filter((c) => c.slug === slug) : communes;
    if (!wanted.length) throw new Error("Commune inconnue");
    const datas = await Promise.all(wanted.map((c) => fetchJSON(`/api/communes/${encodeURIComponent(c.slug)}`)));
    // pour un secteur, on affiche aussi les secteurs voisins des autres communes
    const neighbours = sectorId !== null
      ? await Promise.all(communes.filter((c) => c.slug !== slug).map((c) => fetchJSON(`/api/communes/${encodeURIComponent(c.slug)}`)))
      : [];

    const sector = sectorId !== null ? datas[0].sectors.find((s) => s.id === sectorId) : null;
    if (sectorId !== null && !sector) throw new Error("Secteur introuvable (a-t-il été supprimé ?)");

    document.getElementById("plan-commune").textContent = datas.map((d) => d.commune.nom).join(" · ");
    document.getElementById("plan-date").textContent = `imprimé le ${new Date().toLocaleDateString("fr-FR")}`;
    document.body.classList.add(sector ? "plan-sector" : "plan-overview");

    const map = L.map("plan-map", { zoomControl: true, zoomSnap: 0.25 }).setView([45.742, 4.57], 13);
    const tiles = osmLayer().addTo(map);
    tiles.once("load", enablePrint);
    setTimeout(enablePrint, 8000);
    [...datas, ...neighbours].forEach((d) => contour(d.commune)?.addTo(map));

    const bounds = L.latLngBounds([]);
    if (sector) {
      const polys = toPolys(sector.polygon);
      document.title = `Plan — ${sector.nom}`;
      document.getElementById("plan-title").textContent = sector.nom;
      document.getElementById("plan-subtitle").textContent =
        `${datas[0].commune.nom} · ${sector.addresses.length} adresses${polys.length > 1 ? ` · ${polys.length} morceaux` : ""}`;
      document.getElementById("plan-dot").style.background = sector.couleur;

      const mask = { stroke: false, fillColor: "#0b1220", fillOpacity: 0.45, interactive: false };
      L.polygon([WORLD, ...outerRings(polys)], mask).addTo(map);
      holeRings(polys).forEach((hole) => L.polygon(hole, mask).addTo(map));
      for (const other of [...datas, ...neighbours].flatMap((d) => d.sectors)) {
        if (other.id === sector.id) continue;
        L.polygon(toPolys(other.polygon), { color: other.couleur, weight: 1.5, dashArray: "4 4", fill: false, interactive: false }).addTo(map);
        label(other, true).addTo(map);
      }
      const outline = L.polygon(polys, { color: sector.couleur, weight: 5, fill: false, interactive: false }).addTo(map);
      for (const a of sector.addresses) {
        L.circleMarker([a.lat, a.lon], { radius: 3, color: "#fff", weight: 1, fillColor: "#3b4656", fillOpacity: 1, interactive: false }).addTo(map);
      }
      bounds.extend(outline.getBounds());

      document.getElementById("plan-limite-block").hidden = false;
      renderLimite(document.getElementById("plan-limite"), sector.limite);
      document.getElementById("plan-resume-block").hidden = false;
      renderResume(document.getElementById("plan-resume"), sector.resume);
    } else {
      const names = datas.map((d) => d.commune.nom).join(" et ");
      const nb = datas.reduce((n, d) => n + d.sectors.length, 0);
      document.title = `Plan des secteurs — ${names}`;
      document.getElementById("plan-title").textContent = `Plan des secteurs — ${names}`;
      document.getElementById("plan-subtitle").textContent = `${nb} secteurs`;
      document.getElementById("plan-dot").hidden = true;

      const rows = [];
      for (const d of datas) {
        if (datas.length > 1) rows.push(`<tr><th colspan="4">${escapeHtml(d.commune.nom)}</th></tr>`);
        for (const s of d.sectors) {
          const poly = L.polygon(toPolys(s.polygon), { color: s.couleur, weight: 3, fillColor: s.couleur, fillOpacity: 0.25, interactive: false }).addTo(map);
          label(s, false).addTo(map);
          bounds.extend(poly.getBounds());
          rows.push(`<tr>
            <td><span class="color-dot" style="background:${s.couleur}"></span></td>
            <td><strong>${escapeHtml(s.nom)}</strong></td>
            <td>${s.addresses.length} adresses</td>
            <td class="hint">${escapeHtml(hameauxPreview(s.resume, 4))}</td>
          </tr>`);
        }
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
