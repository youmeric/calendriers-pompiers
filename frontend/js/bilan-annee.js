/* Bilan de l'année, à imprimer pour l'assemblée générale : chiffres clés, moyens de paiement,
   dons par secteur comparés à la tournée précédente, détail par secteur, caisse. */
(() => {
  "use strict";
  const { escapeHtml, fetchJSON, showToast, sectorCode } = window.Common;
  const $ = (id) => document.getElementById(id);
  const euros = (v) => `${Number(v || 0).toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} €`;
  const euros2 = (v) => `${Number(v || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  // couleurs des séries (validées daltonisme) : année du bilan, année précédente ; puis moyens de paiement
  const COLOR_NOW = "#2a78d6";
  const COLOR_PREV = "#eb6834";
  const MODE_COLORS = { especes: "#2a78d6", cheque: "#eb6834", cb: "#1baf7a" };
  const MODE_LABEL = { especes: "Espèces", cheque: "Chèques", cb: "Carte" };

  function evolution(now, prev, unit = "%") {
    if (prev === null || prev === undefined) return "";
    if (!prev) return now ? `<span class="evo up">nouveau</span>` : "";
    const d = ((now - prev) / prev) * 100;
    if (Math.abs(d) < 0.5) return `<span class="evo flat">= stable</span>`;
    return `<span class="evo ${d > 0 ? "up" : "down"}">${d > 0 ? "▲ +" : "▼ "}${Math.round(d)} ${unit}</span>`;
  }

  function kpis(r) {
    const Y = String(r.annee);
    const P = r.precedente ? String(r.precedente) : null;
    const t = r.totaux[Y];
    const p = P ? r.totaux[P] : null;
    const passees = (x) => x.fait + x.absent + x.refus;
    const moyenne = (x) => (x.dons.nb ? x.dons.total / x.dons.nb : 0);
    const parMaison = (x) => (x.fait ? x.dons.total / x.fait : 0);
    const vs = P ? `<small>en ${P} : ` : "";
    const tile = (label, value, sub, evo, prevText) => `<div class="report-kpi">
        <span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}
        ${P ? `<p>${evo || ""} ${vs}${prevText}</small></p>` : ""}</div>`;
    $("rp-kpis").innerHTML = [
      tile("Total des dons", euros(t.dons.total), `${t.dons.nb} don${t.dons.nb > 1 ? "s" : ""}`, p && evolution(t.dons.total, p.dons.total), p ? euros(p.dons.total) : ""),
      tile("Maisons faites", `${t.fait}<small> / ${t.adresses}</small>`, `${pct(t.fait, t.adresses)} % des maisons · ${passees(t)} passées`, p && evolution(t.fait, p.fait), p ? `${p.fait}` : ""),
      tile("Don moyen", euros2(moyenne(t)), "par don reçu", p && evolution(moyenne(t), moyenne(p)), p ? euros2(moyenne(p)) : ""),
      tile("Par maison faite", euros2(parMaison(t)), "total ÷ maisons faites", p && evolution(parMaison(t), parMaison(p)), p ? euros2(parMaison(p)) : ""),
      tile("Absents · refus", `${t.absent} · ${t.refus}`, `${pct(t.absent, t.adresses)} % absents · ${pct(t.refus, t.adresses)} % refus`, "", p ? `${p.absent} · ${p.refus}` : ""),
    ].join("");
  }

  /** Une barre empilée espèces / chèques / carte, avec légende et montants. */
  function modes(t) {
    const total = t.dons.especes + t.dons.cheque + t.dons.cb;
    if (!total) { $("rp-modes").innerHTML = `<p class="hint">Aucun don enregistré.</p>`; return; }
    const W = 640;
    const H = 22;
    let x = 0;
    const segs = ["especes", "cheque", "cb"].filter((k) => t.dons[k] > 0).map((k, i, arr) => {
      const w = (t.dons[k] / total) * W;
      const gap = i < arr.length - 1 ? 2 : 0; // 2 px de fond entre deux segments
      const first = i === 0;
      const last = i === arr.length - 1;
      const seg = `<path d="${roundedBar(x, 0, Math.max(1, w - gap), H, first ? 4 : 0, last ? 4 : 0)}" fill="${MODE_COLORS[k]}"><title>${MODE_LABEL[k]} : ${euros2(t.dons[k])} (${pct(t.dons[k], total)} %)</title></path>`;
      x += w;
      return seg;
    });
    $("rp-modes").innerHTML = `<svg class="report-modes" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Répartition des dons par moyen de paiement">${segs.join("")}</svg>
      <div class="report-legend">${["especes", "cheque", "cb"].map((k) => `<span><i style="background:${MODE_COLORS[k]}"></i>${MODE_LABEL[k]} <b>${euros(t.dons[k])}</b> · ${pct(t.dons[k], total)} %</span>`).join("")}</div>`;
  }

  /** Barre horizontale : arrondi de 4 px côté valeur seulement (carré sur la ligne de base). */
  function roundedBar(x, y, w, h, rl, rr) {
    rl = Math.min(rl, w / 2, h / 2);
    rr = Math.min(rr, w / 2, h / 2);
    return `M${x + rl},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}`
      + `H${x + rl}Q${x},${y + h} ${x},${y + h - rl}V${y + rl}Q${x},${y} ${x + rl},${y}Z`;
  }

  /** Graduations rondes (1, 2 ou 5 × 10ⁿ) couvrant 0 → v, environ 4 intervalles. */
  function niceTicks(v) {
    const raw = Math.max(v, 1) / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((m) => m >= raw);
    const n = Math.max(1, Math.ceil(v / step));
    return Array.from({ length: n + 1 }, (_, i) => i * step);
  }

  /** Dons par secteur : barres groupées, année du bilan et année précédente. */
  function chart(r, codes) {
    const Y = String(r.annee);
    const P = r.precedente ? String(r.precedente) : null;
    $("rp-chart-title").textContent = P ? `Dons par secteur, ${Y} comparé à ${P}` : `Dons par secteur en ${Y}`;
    $("rp-legend").innerHTML = P
      ? `<span><i style="background:${COLOR_NOW}"></i>${Y}</span><span><i style="background:${COLOR_PREV}"></i>${P}</span>`
      : "";
    const rows = r.secteurs;
    const ticks = niceTicks(Math.max(...rows.flatMap((s) => [s.annees[Y].dons.total, P ? s.annees[P].dons.total : 0])));
    const max = ticks[ticks.length - 1];
    const labelW = 190;
    const valueW = 70;
    const W = 680;
    const plotW = W - labelW - valueW;
    const bar = 14;
    const band = P ? bar * 2 + 2 + 14 : bar + 14;
    const top = 6;
    const H = top + rows.length * band + 22;
    const sx = (v) => labelW + (v / max) * plotW;
    let svg = ticks.map((v) => `<line x1="${sx(v)}" x2="${sx(v)}" y1="${top}" y2="${H - 18}" class="grid" />
      <text x="${sx(v)}" y="${H - 4}" class="tick" text-anchor="middle">${euros(v)}</text>`).join("");
    rows.forEach((s, i) => {
      const y = top + i * band + 4;
      const now = s.annees[Y].dons.total;
      const name = `${codes.get(s.sector_id) || ""} ${s.nom}`;
      svg += `<text x="${labelW - 10}" y="${y + (P ? bar + 1 : bar / 2)}" class="lbl" text-anchor="end" dominant-baseline="middle">${escapeHtml(name.length > 26 ? `${name.slice(0, 25)}…` : name)}</text>`;
      svg += `<path d="${roundedBar(labelW, y, Math.max(1, sx(now) - labelW), bar, 0, 4)}" fill="${COLOR_NOW}"><title>${escapeHtml(name)} — ${Y} : ${euros2(now)}</title></path>`;
      svg += `<text x="${sx(now) + 6}" y="${y + bar / 2}" class="val" dominant-baseline="middle">${euros(now)}</text>`;
      if (P) {
        const prev = s.annees[P].dons.total;
        svg += `<path d="${roundedBar(labelW, y + bar + 2, Math.max(1, sx(prev) - labelW), bar, 0, 4)}" fill="${COLOR_PREV}"><title>${escapeHtml(name)} — ${P} : ${euros2(prev)}</title></path>`;
      }
    });
    $("rp-chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml($("rp-chart-title").textContent)}">${svg}</svg>`;
  }

  function table(r, codes) {
    const Y = String(r.annee);
    const P = r.precedente ? String(r.precedente) : null;
    const head = `<thead><tr><th>Secteur</th><th>Responsable</th><th>Maisons</th><th>Faites</th><th>Abs.</th><th>Refus</th>
      <th>Dons</th><th>Total ${Y}</th><th>Moyenne</th>${P ? `<th>Total ${P}</th><th>Évolution</th>` : ""}</tr></thead>`;
    const line = (label, resp, x, px, cls = "") => `<tr class="${cls}"><td>${label}</td><td>${resp}</td><td>${x.adresses}</td>
      <td>${x.fait} <small>${pct(x.fait, x.adresses)} %</small></td><td>${x.absent}</td><td>${x.refus}</td>
      <td>${x.dons.nb}</td><td><b>${euros2(x.dons.total)}</b></td><td>${x.dons.nb ? euros2(x.dons.total / x.dons.nb) : "—"}</td>
      ${P ? `<td>${euros2(px.dons.total)}</td><td>${evolution(x.dons.total, px.dons.total) || "—"}</td>` : ""}</tr>`;
    const body = r.secteurs.map((s) => line(
      `<b>${escapeHtml(codes.get(s.sector_id) || "")}</b> ${escapeHtml(s.nom)}<small>${escapeHtml(s.commune)}</small>`,
      escapeHtml(s.responsables.join(", ") || "—"), s.annees[Y], P ? s.annees[P] : null,
    )).join("");
    $("rp-table").innerHTML = `${head}<tbody>${body}${line("<b>Total</b>", "", r.totaux[Y], P ? r.totaux[P] : null, "total")}</tbody>`;
    $("rp-note").textContent = P
      ? `Pour comparer à surface égale, les maisons et les dons de ${P} sont rangés dans le secteur où se trouve aujourd'hui leur adresse.`
      : "Première tournée enregistrée : la comparaison apparaîtra l'an prochain.";
  }

  async function load(annee) {
    let r;
    try {
      r = await fetchJSON(`/api/admin/bilan-annee${annee ? `?annee=${annee}` : ""}`);
    } catch (err) {
      if (err.status === 401) { $("rp-login").hidden = false; return; }
      showToast(err.message, true);
      return;
    }
    const index = await fetchJSON("/api/communes");
    const codes = new Map();
    for (const c of index.communes) {
      const d = await fetchJSON(`/api/communes/${encodeURIComponent(c.slug)}`);
      d.sectors.forEach((s, i) => codes.set(s.id, sectorCode(d.commune.nom, i)));
    }
    const years = [...new Set([...r.annees, r.annee])].sort((a, b) => b - a);
    $("rp-annee").innerHTML = years.map((y) => `<option value="${y}"${y === r.annee ? " selected" : ""}>${y}</option>`).join("");
    $("rp-title").textContent = `Bilan de la tournée des calendriers ${r.annee}`;
    document.title = `Bilan ${r.annee} — Sapeurs-pompiers de Courzieu`;
    $("rp-sub").textContent = r.precedente ? `Comparé à la tournée ${r.precedente}` : "Première tournée enregistrée sur le site";
    kpis(r);
    modes(r.totaux[String(r.annee)]);
    chart(r, codes);
    table(r, codes);
    const c = r.remises;
    $("rp-caisse").innerHTML = c.nb
      ? `${c.nb} remise${c.nb > 1 ? "s" : ""} au trésorier pour <b>${euros2(c.total)}</b> (espèces et chèques), dont ${c.confirmees} confirmée${c.confirmees > 1 ? "s" : ""} à réception. Les paiements par carte arrivent directement sur le compte SumUp.`
      : "Aucune remise de caisse enregistrée.";
    $("rp-foot").textContent = `Édité le ${new Date().toLocaleDateString("fr-FR", { dateStyle: "long" })} depuis le site de la tournée des calendriers`;
    $("rp-sheet").hidden = false;
  }

  $("rp-annee").addEventListener("change", () => load($("rp-annee").value));
  $("rp-print").addEventListener("click", () => window.print());
  load(new URLSearchParams(location.search).get("annee"));
})();
