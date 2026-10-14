(() => {
  "use strict";
  const {
    escapeHtml, fetchJSON, showToast, labelPoint, renderLimite, renderResume, hameauxPreview,
    toPolys, outerRings, holeRings, addBaseLayers, sectorCode, labelHtml,
  } = window.Common;

  const WORLD = [[85, -180], [85, 180], [-85, 180], [-85, -180]];
  const OPTIONS_KEY = "plan-options";
  const DEFAULTS = {
    secteur: {
      outside: "blanc", houses: true, others: false, contour: false,
      limite: true, resume: true, adresses: false, qr: true, orientation: "portrait",
    },
    ensemble: {
      outsideAll: "blanc", houses: false, labels: "noms", contour: true,
      legend: true, qr: true, orientation: "portrait",
    },
  };
  const MASKS = {
    blanc: { fillColor: "#fff", fillOpacity: 1 },
    estompe: { fillColor: "#fff", fillOpacity: 0.65 },
    grise: { fillColor: "#0b1220", fillOpacity: 0.45 },
  };

  const $ = (id) => document.getElementById(id);
  const printBtn = $("btn-print");
  const pdfBtn = $("btn-pdf");

  let map;
  let mode; // "secteur" | "ensemble"
  let opts;
  let fitTarget = null;
  const groups = {};

  /* ------------------------------ options mémorisées ------------------------------ */

  function loadOptions() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(OPTIONS_KEY)) || {}; } catch { /* indisponible */ }
    return { ...DEFAULTS[mode], ...(saved[mode] || {}) };
  }

  function saveOptions() {
    try {
      const all = JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}");
      all[mode] = opts;
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(all));
    } catch { /* indisponible */ }
  }

  /** Relie chaque champ du panneau à une option (checkbox ou liste). */
  function bindOptions() {
    const form = $("plan-options");
    form.querySelectorAll(mode === "secteur" ? ".only-overview" : ".only-sector").forEach((el) => { el.hidden = true; });
    for (const key of Object.keys(DEFAULTS[mode])) {
      const input = $(`opt-${key === "outsideAll" ? "outside-all" : key}`);
      if (!input) continue;
      if (input.type === "checkbox") input.checked = !!opts[key];
      else input.value = opts[key];
      input.addEventListener("change", () => {
        opts[key] = input.type === "checkbox" ? input.checked : input.value;
        saveOptions();
        applyOptions();
      });
    }
    form.addEventListener("submit", (e) => e.preventDefault());
    const toggle = $("btn-options");
    toggle.addEventListener("click", () => {
      form.hidden = !form.hidden;
      toggle.setAttribute("aria-expanded", String(!form.hidden));
    });
    $("btn-refit").addEventListener("click", refit);
  }

  /* --------------------------------- couches carte --------------------------------- */

  function label(sector, small) {
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

  function contourRings(commune) {
    const g = commune.contour && (commune.contour.geometry || commune.contour);
    if (!g) return [];
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    return polys.map((p) => p.map((ring) => ring.map(([lon, lat]) => [lat, lon])));
  }

  /** Masque tout ce qui est hors des anneaux donnés (trous éventuels compris). */
  function buildMask(group, polys, style) {
    group.clearLayers();
    if (!style) return;
    const mask = { ...style, stroke: false, interactive: false, pane: "maskPane" };
    L.polygon([WORLD, ...outerRings(polys)], mask).addTo(group);
    holeRings(polys).forEach((hole) => L.polygon(hole, mask).addTo(group));
  }

  function houseMarker(a, color) {
    return L.circleMarker([a.lat, a.lon], {
      radius: 3, color: "#fff", weight: 1, fillColor: color, fillOpacity: 1, interactive: false, pane: "housesPane",
    });
  }

  function createPanes() {
    // ordre fixe quelles que soient les options cochées
    [["maskPane", 405], ["othersPane", 410], ["mainPane", 420], ["housesPane", 430]].forEach(([name, z]) => {
      map.createPane(name).style.zIndex = z;
    });
    ["contour", "mask", "others", "main", "houses", "labels"].forEach((k) => { groups[k] = L.layerGroup().addTo(map); });
  }

  function show(group, visible) {
    if (visible && !map.hasLayer(groups[group])) groups[group].addTo(map);
    if (!visible && map.hasLayer(groups[group])) map.removeLayer(groups[group]);
  }

  /* ---------------------------------- application ---------------------------------- */

  let ctx; // données du plan affiché

  function applyOptions() {
    const sector = mode === "secteur";
    show("contour", opts.contour);
    show("houses", opts.houses);
    if (sector) {
      buildMask(groups.mask, ctx.polys, MASKS[opts.outside]);
      show("others", opts.others);
      $("plan-limite-block").hidden = !opts.limite;
      $("plan-resume-block").hidden = !opts.resume;
      $("plan-adresses-block").hidden = !opts.adresses;
    } else {
      buildMask(groups.mask, ctx.communeRings, MASKS[opts.outsideAll]);
      show("labels", opts.labels !== "aucune");
      map.getContainer().classList.toggle("labels-compact", opts.labels === "codes");
      $("plan-legend").hidden = !opts.legend;
    }
    $("plan-qr").closest("figure").hidden = !opts.qr || !ctx.qrOk;

    const detail = sector ? (opts.limite || opts.resume || opts.adresses) : opts.legend;
    document.body.classList.toggle("plan-no-detail", !detail);
    document.body.classList.toggle("plan-landscape", opts.orientation === "landscape");
    $("page-size").textContent = `@page { size: A4 ${opts.orientation}; margin: 10mm; }`;
    refit();
  }

  function refit() {
    map.invalidateSize();
    if (fitTarget && fitTarget.isValid()) map.fitBounds(fitTarget, { padding: [12, 12], animate: false });
  }

  function renderSector(slug, data, sector, everyone) {
    const polys = toPolys(sector.polygon);
    ctx.polys = polys;
    document.title = `Plan — ${sector.code} ${sector.nom}`;
    $("plan-title").innerHTML =
      `<b class="sector-code" style="background:${sector.couleur}">${escapeHtml(sector.code)}</b> ${escapeHtml(sector.nom)}`;
    $("plan-subtitle").textContent =
      `${data.commune.nom} · ${sector.addresses.length} adresses${polys.length > 1 ? ` · ${polys.length} morceaux` : ""}`;

    for (const other of everyone) {
      if (other === sector) continue;
      L.polygon(toPolys(other.polygon), {
        color: other.couleur, weight: 1.5, dashArray: "4 4", fill: false, interactive: false, pane: "othersPane",
      }).addTo(groups.others);
      label(other, true).addTo(groups.others);
    }
    const outline = L.polygon(polys, { color: sector.couleur, weight: 5, fill: false, interactive: false, pane: "mainPane" })
      .addTo(groups.main);
    sector.addresses.forEach((a) => houseMarker(a, "#3b4656").addTo(groups.houses));
    fitTarget = outline.getBounds();

    renderLimite($("plan-limite"), sector.limite);
    renderResume($("plan-resume"), sector.resume);
    renderAddresses($("plan-adresses"), sector.addresses);
  }

  function renderOverview(datas) {
    const names = datas.map((d) => d.commune.nom).join(" et ");
    const nb = datas.reduce((n, d) => n + d.sectors.length, 0);
    document.title = `Plan des secteurs — ${names}`;
    $("plan-title").textContent = `Plan des secteurs — ${names}`;
    $("plan-subtitle").textContent = `${nb} secteur${nb > 1 ? "s" : ""}`;

    const bounds = L.latLngBounds([]);
    const rows = [];
    for (const d of datas) {
      if (datas.length > 1) rows.push(`<tr><th colspan="4">${escapeHtml(d.commune.nom)}</th></tr>`);
      for (const s of d.sectors) {
        const poly = L.polygon(toPolys(s.polygon), {
          color: s.couleur, weight: 3, fillColor: s.couleur, fillOpacity: 0.25, interactive: false, pane: "mainPane",
        }).addTo(groups.main);
        label(s, false).addTo(groups.labels);
        s.addresses.forEach((a) => houseMarker(a, s.couleur).addTo(groups.houses));
        bounds.extend(poly.getBounds());
        rows.push(`<tr>
          <td><b class="sector-code" style="background:${s.couleur}">${escapeHtml(s.code)}</b></td>
          <td><strong>${escapeHtml(s.nom)}</strong></td>
          <td>${s.addresses.length} adresses</td>
          <td class="hint">${escapeHtml(hameauxPreview(s.resume, 4))}</td>
        </tr>`);
      }
    }
    $("plan-legend-body").innerHTML = rows.join("");
    // sans secteur encore défini : on cadre sur les communes
    ctx.communeRings.forEach((p) => p[0] && bounds.extend(p[0]));
    fitTarget = bounds;
  }

  /** Liste compacte : une ligne par voie avec ses numéros. */
  function renderAddresses(container, addresses) {
    const byVoie = new Map();
    for (const a of addresses) {
      const voie = a.nom_voie || a.groupe || a.label;
      if (!byVoie.has(voie)) byVoie.set(voie, []);
      byVoie.get(voie).push(a.numero ? String(a.numero) : "s.n.");
    }
    const num = (s) => parseInt(s, 10) || 0;
    const voies = [...byVoie.keys()].sort((x, y) => x.localeCompare(y, "fr"));
    container.innerHTML = voies.length
      ? voies.map((v) => {
        const nums = [...new Set(byVoie.get(v))].sort((x, y) => num(x) - num(y) || x.localeCompare(y, "fr"));
        return `<p class="adresse-voie"><strong>${escapeHtml(v)}</strong> : ${nums.map(escapeHtml).join(", ")}</p>`;
      }).join("")
      : `<p class="hint">Aucune adresse dans ce secteur.</p>`;
  }

  function fillPlanChoice(all, slug, sectorId) {
    const select = $("opt-plan");
    const opt = (value, text) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`;
    let html = opt("#/", all.length > 1 ? "Ensemble — toutes les communes" : `Ensemble — ${all[0].commune.nom}`);
    for (const d of all) {
      const s = encodeURIComponent(d.commune.slug);
      html += `<optgroup label="${escapeHtml(d.commune.nom)}">`;
      if (all.length > 1) html += opt(`#/${s}`, `${d.commune.nom} — tous les secteurs`);
      html += d.sectors.map((x) => opt(`#/${s}/${x.id}`, `${x.code} · ${x.nom}`)).join("");
      html += "</optgroup>";
    }
    select.innerHTML = html;
    select.value = sectorId !== null ? `#/${encodeURIComponent(slug)}/${sectorId}`
      : slug && all.length > 1 ? `#/${encodeURIComponent(slug)}` : "#/";
    select.addEventListener("change", () => {
      location.hash = select.value;
      location.reload();
    });
  }

  function enablePrint() {
    if (!printBtn.disabled) return;
    printBtn.disabled = false;
    pdfBtn.disabled = false;
    printBtn.textContent = "🖨 Imprimer";
  }

  async function init() {
    const hash = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const slug = hash[0] ? decodeURIComponent(hash[0]) : null;
    const sectorId = hash[1] ? Number(hash[1]) : null;

    // toutes les communes : pour le choix du plan et pour les secteurs voisins
    const { communes } = await fetchJSON("/api/communes");
    if (slug && !communes.some((c) => c.slug === slug)) throw new Error("Commune inconnue");
    const all = await Promise.all(communes.map((c) => fetchJSON(`/api/communes/${encodeURIComponent(c.slug)}`)));
    all.forEach((d) => d.sectors.forEach((s, i) => { s.code = sectorCode(d.commune.nom, i); }));
    const datas = slug ? all.filter((d) => d.commune.slug === slug) : all;
    const sector = sectorId !== null ? datas[0].sectors.find((s) => s.id === sectorId) : null;
    if (sectorId !== null && !sector) throw new Error("Secteur introuvable (a-t-il été supprimé ?)");

    mode = sector ? "secteur" : "ensemble";
    opts = loadOptions();
    document.body.classList.add(sector ? "plan-sector" : "plan-overview");
    fillPlanChoice(all, slug, sector ? sectorId : null);
    $("plan-commune").textContent = datas.map((d) => d.commune.nom).join(" · ");
    $("plan-date").textContent = `imprimé le ${new Date().toLocaleDateString("fr-FR")}`;

    map = L.map("plan-map", { zoomControl: true, zoomSnap: 0.25 }).setView([45.742, 4.57], 13);
    const tiles = addBaseLayers(map);
    tiles.once("load", enablePrint);
    setTimeout(enablePrint, 8000);
    createPanes();

    // limite de commune : celle(s) du plan, plus la voisine si on montre les secteurs voisins
    const shown = sector ? all : datas;
    shown.forEach((d) => {
      if (d.commune.contour) {
        L.geoJSON(d.commune.contour, {
          style: { color: "#1c2430", weight: 2, dashArray: "8 6", fill: false, opacity: 0.6 }, interactive: false, pane: "othersPane",
        }).addTo(groups.contour);
      }
    });

    ctx = { communeRings: datas.flatMap((d) => contourRings(d.commune)), qrOk: renderQr(sector
      ? `${location.origin}/#/${encodeURIComponent(slug)}/${sector.id}`
      : `${location.origin}/`) };
    if (sector) renderSector(slug, datas[0], sector, all.flatMap((d) => d.sectors));
    else renderOverview(datas);

    bindOptions();
    applyOptions();
    window.addEventListener("beforeprint", refit);
  }

  function renderQr(url) {
    const box = $("plan-qr");
    if (typeof qrcode !== "function") return false;
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
    box.title = url;
    return true;
  }

  printBtn.addEventListener("click", () => window.print());
  pdfBtn.addEventListener("click", () => {
    showToast("Dans la fenêtre qui s'ouvre, choisissez « Enregistrer au format PDF » comme imprimante.");
    setTimeout(() => window.print(), 900);
  });

  init().catch((err) => {
    console.error(err);
    showToast(err.message, true);
    printBtn.textContent = "Erreur de chargement";
  });
})();
