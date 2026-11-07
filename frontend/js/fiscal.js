/* Dossier comptable et fiscal de la tournée : de quoi répondre à un contrôle.
   Synthèse, journal de caisse jour par jour, chaîne des espèces et chèques (terrain → trésorier → banque),
   secteurs, personnes, remises, dépôts, annulations, registre numéroté ; clôture avec archive scellée. */
(() => {
  "use strict";
  const { escapeHtml, fetchJSON, showToast, parseEuros } = window.Common;
  const $ = (id) => document.getElementById(id);
  const eur = (v) => `${Number(v || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const MODE = { especes: "Espèces", cheque: "Chèque", cb: "Carte" };
  const STATUT = { ok: "Encaissé", attente: "En attente (SumUp)", echec: "Paiement refusé", annule: "Annulé" };
  const paris = { timeZone: "Europe/Paris" };
  const dateFr = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR", paris) : "");
  const dateTimeFr = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { ...paris, dateStyle: "short", timeStyle: "short" }) : "");
  const dayFr = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  const COLOR = "#2a78d6"; // une seule série : le total encaissé du jour

  let me = null;
  let annee = null;

  async function api(url, options) {
    try {
      return await fetchJSON(url, options);
    } catch (err) {
      if (err.status === 401) msg(`Connectez-vous d'abord à l'<a href="/admin">administration</a>, puis rouvrez cette page.`);
      else if (err.status === 403) msg("Ce dossier est réservé aux comptes qui ont le droit « Dons et caisse ».");
      throw err;
    }
  }
  const send = (url, method, body) => api(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

  function msg(html) {
    $("fx-msg").innerHTML = html;
    $("fx-msg").hidden = false;
    $("fx-sheet").hidden = true;
    $("fx-tools").hidden = true;
  }

  const table = (id, head, rows, foot) => {
    $(id).innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows.join("") || `<tr><td colspan="${head.length}" class="hint">Aucun.</td></tr>`}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ""}`;
  };

  function header(f) {
    const a = f.association;
    $("fx-asso-line").textContent = [a.nom || "Sapeurs-pompiers de Courzieu", a.adresse, a.siret && `RNA / SIRET ${a.siret}`].filter(Boolean).join(" · ");
    $("fx-title").textContent = `Dossier comptable — Tournée des calendriers ${f.annee}`;
    const p = f.periode;
    $("fx-sub").textContent = `${p.debut ? `Dons du ${dateFr(p.debut)} au ${dateFr(p.fin)}` : "Aucun don encaissé"} · édité le ${dateTimeFr(f.edite_le)}`;
    const c = f.cloture;
    $("fx-status").innerHTML = c
      ? `<div class="fx-badge closed"><b>🔒 Tournée clôturée</b> le ${dateTimeFr(c.cloture_le)} par ${escapeHtml(c.par)} : ${c.nb_dons} dons, ${eur(c.total_cents / 100)}.
          <span>Empreinte SHA-256 du registre archivé : <code>${c.sha256}</code></span></div>`
      : `<div class="fx-badge open"><b>Tournée en cours</b> : chiffres provisoires, ils évoluent avec les saisies. Clôturez l'année une fois la tournée et la caisse terminées.</div>`;
    document.title = `Dossier comptable ${f.annee} — Sapeurs-pompiers de Courzieu`;
  }

  function kpis(f) {
    const s = f.synthese;
    const m = f.maisons;
    const tile = (label, value, sub) => `<div class="report-kpi"><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}</div>`;
    $("fx-kpis").innerHTML = [
      tile("Total encaissé", eur(s.total), `${s.nb} don${s.nb > 1 ? "s" : ""} · moyenne ${eur(s.moyen)}`),
      tile("Espèces", eur(s.especes), `${s.nb_especes} don${s.nb_especes > 1 ? "s" : ""}`),
      tile("Chèques", eur(s.cheque), `${s.nb_cheque} chèque${s.nb_cheque > 1 ? "s" : ""}`),
      tile("Carte (SumUp)", eur(s.cb), `${s.nb_cb} paiement${s.nb_cb > 1 ? "s" : ""}`),
      tile("Maisons", `${m.fait}<small> / ${m.adresses}</small>`, `faites · ${m.absent} absents · ${m.refus} refus`),
    ].join("");
    const hors = [];
    if (s.annules.nb) hors.push(`${s.annules.nb} don${s.annules.nb > 1 ? "s" : ""} annulé${s.annules.nb > 1 ? "s" : ""} (${eur(s.annules.total)})`);
    if (s.echecs.nb) hors.push(`${s.echecs.nb} paiement${s.echecs.nb > 1 ? "s" : ""} carte refusé${s.echecs.nb > 1 ? "s" : ""} (${eur(s.echecs.total)})`);
    if (s.attente.nb) hors.push(`<b class="fx-warn">${s.attente.nb} paiement${s.attente.nb > 1 ? "s" : ""} carte en attente (${eur(s.attente.total)}) à valider</b>`);
    $("fx-hors").innerHTML = hors.length ? `<p class="fx-explain">Non comptés dans les totaux : ${hors.join(" · ")}.</p>` : "";
  }

  /** Barres verticales : total encaissé par jour (une seule série, donc pas de légende). */
  function chart(jours) {
    if (!jours.length) { $("fx-chart").innerHTML = ""; return; }
    const W = 680;
    const H = 180;
    const left = 52;
    const bottom = 24;
    const top = 16;
    const plotW = W - left - 8;
    const plotH = H - top - bottom;
    const raw = Math.max(...jours.map((j) => j.total), 1) / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((x) => x * mag).find((x) => x >= raw);
    const max = step * Math.ceil(Math.max(...jours.map((j) => j.total), 1) / step);
    const band = plotW / jours.length;
    const bw = Math.min(24, band * 0.6);
    const y = (v) => top + plotH - (v / max) * plotH;
    let svg = "";
    for (let v = 0; v <= max + 1e-9; v += step) {
      svg += `<line x1="${left}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" class="grid" /><text x="${left - 6}" y="${y(v)}" class="tick" text-anchor="end" dominant-baseline="middle">${Math.round(v).toLocaleString("fr-FR")} €</text>`;
    }
    const best = jours.reduce((a, b) => (b.total > a.total ? b : a));
    jours.forEach((j, i) => {
      const x = left + i * band + (band - bw) / 2;
      const h = Math.max(1, (j.total / max) * plotH);
      const r = Math.min(4, h, bw / 2);
      const yt = top + plotH - h;
      svg += `<path d="M${x},${top + plotH}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + bw - r}Q${x + bw},${yt} ${x + bw},${yt + r}V${top + plotH}Z" fill="${COLOR}">
        <title>${dayFr(j.date)} : ${eur(j.total)} (${j.nb} dons)</title></path>`;
      if (jours.length <= 10 || j === best) svg += `<text x="${x + bw / 2}" y="${yt - 4}" class="val" text-anchor="middle">${Math.round(j.total).toLocaleString("fr-FR")} €</text>`;
      if (jours.length <= 14 || i % Math.ceil(jours.length / 14) === 0) svg += `<text x="${x + bw / 2}" y="${H - 6}" class="tick" text-anchor="middle">${escapeHtml(dayFr(j.date))}</text>`;
    });
    $("fx-chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Total encaissé par jour">${svg}</svg>`;
  }

  function render(f) {
    header(f);
    kpis(f);
    chart(f.jours);
    const s = f.synthese;
    table("fx-jours", ["Date", "Dons", "Espèces", "Chèques", "Carte", "Total du jour", "Cumul"],
      f.jours.map((j) => `<tr><td>${escapeHtml(dayFr(j.date))}</td><td>${j.nb}</td><td>${eur(j.especes)}</td><td>${eur(j.cheque)}</td><td>${eur(j.cb)}</td><td><b>${eur(j.total)}</b></td><td>${eur(j.cumul)}</td></tr>`),
      `<tr class="total"><td>Total</td><td>${s.nb}</td><td>${eur(s.especes)}</td><td>${eur(s.cheque)}</td><td>${eur(s.cb)}</td><td><b>${eur(s.total)}</b></td><td></td></tr>`);

    const c = f.chaine;
    const line = (label, x, cls = "") => `<tr class="${cls}"><td>${label}</td><td>${eur(x.especes)}</td><td>${eur(x.cheques)}</td><td>${x.nb_cheques}</td><td><b>${eur(x.especes + x.cheques)}</b></td></tr>`;
    const flag = (x) => (Math.abs(x.especes) + Math.abs(x.cheques) > 0.004 ? " fx-diff" : "");
    table("fx-chaine", ["", "Espèces", "Chèques", "Nb chèques", "Total"], [
      line("Encaissé sur le terrain (dons saisis)", c.encaisse),
      line("Remis au trésorier", c.remis),
      line("… dont réception confirmée", c.remis_confirme, "sub"),
      line("Déposé en banque", c.depose),
      line("Reste chez les équipes (encaissé − remis)", c.reste_terrain, `reste${flag(c.reste_terrain)}`),
      line("Reste chez le trésorier (remis − déposé)", c.reste_tresorier, `reste${flag(c.reste_tresorier)}`),
    ]);
    $("fx-carte").innerHTML = `💳 Carte : <b>${eur(c.carte.total)}</b> en ${c.carte.nb} paiement${c.carte.nb > 1 ? "s" : ""} SumUp, à rapprocher du relevé SumUp (les n° de transaction sont dans le registre).`;

    table("fx-secteurs", ["Secteur", "Responsable", "Maisons faites", "Dons", "Espèces", "Chèques", "Carte", "Total", "Remis", "Reste"],
      f.secteurs.map((x) => `<tr><td><b>${escapeHtml(x.secteur)}</b></td><td>${escapeHtml(x.responsables.join(", ") || "—")}</td>
        <td>${x.fait} / ${x.adresses}</td><td>${x.nb}</td><td>${eur(x.especes)}</td><td>${eur(x.cheque)}</td><td>${eur(x.cb)}</td><td><b>${eur(x.total)}</b></td>
        <td>${eur(x.remis_especes + x.remis_cheques)}</td><td class="${Math.abs(x.reste) > 0.004 ? "fx-diff" : ""}">${eur(x.reste)}</td></tr>`),
      `<tr class="total"><td>Total</td><td></td><td>${f.maisons.fait} / ${f.maisons.adresses}</td><td>${s.nb}</td><td>${eur(s.especes)}</td><td>${eur(s.cheque)}</td><td>${eur(s.cb)}</td><td><b>${eur(s.total)}</b></td>
        <td>${eur(c.remis.especes + c.remis.cheques)}</td><td>${eur(c.reste_terrain.especes + c.reste_terrain.cheques)}</td></tr>`);

    table("fx-collecteurs", ["Saisi par", "Dons", "Espèces", "Chèques", "Carte", "Total"],
      f.collecteurs.map((x) => `<tr><td>${escapeHtml(x.nom)}</td><td>${x.nb}</td><td>${eur(x.especes)}</td><td>${eur(x.cheque)}</td><td>${eur(x.cb)}</td><td><b>${eur(x.total)}</b></td></tr>`));

    table("fx-remises", ["Date", "Secteur", "Remis par", "Reçu par", "Espèces", "Chèques", "Écart", "Réception"],
      f.remises.map((r) => {
        const ec = r.ecart_especes + r.ecart_cheques;
        return `<tr class="${r.annule_le ? "cancelled" : ""}"><td>${dateTimeFr(r.created_at)}</td><td>${escapeHtml(r.secteur)}</td><td>${escapeHtml(r.remis_par)}</td>
          <td>${escapeHtml(r.recu_par)}${r.note ? `<small>${escapeHtml(r.note)}</small>` : ""}</td><td>${eur(r.especes)}</td><td>${eur(r.cheques)} <small>${r.nb_cheques} chq</small></td>
          <td class="${Math.abs(ec) > 0.004 ? "fx-diff" : ""}">${Math.abs(ec) > 0.004 ? `${ec > 0 ? "+" : ""}${eur(ec)}` : "—"}</td>
          <td>${r.annule_le ? `annulée le ${dateFr(r.annule_le)} par ${escapeHtml(r.annule_par)}` : r.confirme_le ? `✓ ${dateFr(r.confirme_le)}` : "à confirmer"}</td></tr>`;
      }));

    const canEdit = !f.cloture;
    table("fx-depots", ["Date", "Espèces", "Chèques", "Bordereau", "Saisi par", ""],
      f.depots.map((d) => `<tr class="${d.annule_le ? "cancelled" : ""}" data-id="${d.id}"><td>${dateFr(`${d.date_depot}T12:00:00`)}</td><td>${eur(d.especes)}</td>
        <td>${eur(d.cheques)} <small>${d.nb_cheques} chq</small></td><td>${escapeHtml(d.reference || "—")}${d.note ? `<small>${escapeHtml(d.note)}</small>` : ""}</td>
        <td>${escapeHtml(d.par)}</td><td>${d.annule_le ? `annulé par ${escapeHtml(d.annule_par)}` : canEdit ? `<button type="button" class="icon-btn danger no-print" data-cancel-depot title="Annuler ce dépôt" aria-label="Annuler ce dépôt">✕</button>` : ""}</td></tr>`));

    const out = f.registre.filter((r) => r.statut === "annule" || r.statut === "echec");
    table("fx-annules", ["N°", "Saisi le", "Secteur · adresse", "Montant", "Saisi par", "Statut", "Annulé par · motif"],
      out.map((r) => `<tr><td>${r.numero}</td><td>${dateTimeFr(r.created_at)}</td><td>${escapeHtml(r.secteur)}<small>${escapeHtml(r.adresse)}</small></td>
        <td>${eur(r.montant)} <small>${MODE[r.mode]}</small></td><td>${escapeHtml(r.saisi_par)}</td><td>${STATUT[r.statut]}</td>
        <td>${r.annule_le ? `${escapeHtml(r.annule_par || "")}, ${dateTimeFr(r.annule_le)}<small>${escapeHtml(r.motif || "")}</small>` : "—"}</td></tr>`));

    table("fx-registre", ["N°", "Date", "Secteur", "Adresse", "Moyen", "Montant", "Référence", "Saisi par", "Statut"],
      f.registre.map((r) => `<tr class="${r.statut === "ok" ? "" : "cancelled"}"><td>${r.numero}</td><td>${dateTimeFr(r.created_at)}</td>
        <td>${escapeHtml(r.secteur)}</td><td>${escapeHtml(r.adresse)}</td><td>${MODE[r.mode]}</td><td>${eur(r.montant)}</td>
        <td>${escapeHtml(r.reference || "")}</td><td>${escapeHtml(r.saisi_par)}</td><td>${STATUT[r.statut]}</td></tr>`));

    $("fx-foot").innerHTML = `Dossier établi à partir des saisies de l'application de la tournée (horodatées, numérotées, jamais effacées ; modifications tracées au journal).
      ${f.cloture ? `Registre archivé à la clôture — empreinte SHA-256 ${f.cloture.sha256}.` : "Chiffres provisoires tant que l'année n'est pas clôturée."}`;
    tools(f);
  }

  function tools(f) {
    $("fx-tools").hidden = false;
    $("fx-depot-panel").hidden = !!f.cloture;
    $("fx-d-date").value ||= new Date().toISOString().slice(0, 10);
    const a = f.association;
    $("fx-asso-nom").value = a.nom;
    $("fx-asso-adresse").value = a.adresse;
    $("fx-asso-siret").value = a.siret;
    $("fx-cloture-sum").textContent = f.cloture ? `🔒 Tournée ${f.annee} clôturée` : `Clôturer la tournée ${f.annee}`;
    const hist = f.clotures.map((c) => `<li>${c.rouvert_le ? "🔓" : "🔒"} Clôturée le ${dateTimeFr(c.cloture_le)} par ${escapeHtml(c.par)} — ${c.nb_dons} dons, ${eur(c.total_cents / 100)}
        · <a href="/api/admin/fiscal/archive/${c.id}">archive du registre</a> <small>(SHA-256 <code>${c.sha256.slice(0, 16)}…</code>)</small>
        ${c.rouvert_le ? `<br><small>Rouverte le ${dateTimeFr(c.rouvert_le)} par ${escapeHtml(c.rouvert_par)} : ${escapeHtml(c.motif_reouverture)}</small>` : ""}
        ${!c.rouvert_le && me.permissions.includes("comptes") ? `<button type="button" class="btn small" data-reopen="${c.id}">Rouvrir…</button>` : ""}</li>`).join("");
    $("fx-cloture").innerHTML = (f.cloture ? `<p class="hint">Les dons, remises et dépôts de ${f.annee} ne peuvent plus être modifiés. L'archive du registre et son empreinte prouvent qu'il n'a pas changé depuis.</p>`
      : `<p class="hint">À faire quand la tournée est finie et toute la caisse déposée : les dons, remises et dépôts de ${f.annee} sont alors <b>figés</b>,
          le registre est archivé sur le serveur avec son <b>empreinte SHA-256</b> (preuve qu'il n'a pas été modifié ensuite) et une sauvegarde est faite.
          Une réouverture reste possible (compte avec le droit « Comptes »), avec un motif, et reste tracée.</p>
         <button type="button" class="btn primary" id="fx-close">🔒 Clôturer la tournée ${f.annee}</button>`)
      + (hist ? `<ul class="fx-hist">${hist}</ul>` : "");
  }

  async function load(y) {
    try {
      if (!me) me = await api("/api/admin/me");
      const f = await api(`/api/admin/fiscal${y ? `?annee=${y}` : ""}`);
      annee = f.annee;
      $("fx-annee").innerHTML = f.annees.map((a) => `<option value="${a}"${a === f.annee ? " selected" : ""}>${a}</option>`).join("");
      $("fx-csv").href = `/api/admin/fiscal/registre.csv?annee=${f.annee}`;
      $("fx-caisse-csv").href = `/api/admin/fiscal/caisse.csv?annee=${f.annee}`;
      $("fx-msg").hidden = true;
      $("fx-sheet").hidden = false;
      render(f);
    } catch (err) {
      if (![401, 403].includes(err.status)) showToast(err.message, true);
    }
  }

  $("fx-annee").addEventListener("change", () => load($("fx-annee").value));
  $("fx-print").addEventListener("click", () => window.print());

  $("fx-asso").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await send("/api/admin/settings", "PUT", { asso_nom: $("fx-asso-nom").value, asso_adresse: $("fx-asso-adresse").value, asso_siret: $("fx-asso-siret").value });
      showToast("Association enregistrée ✓");
      await load(annee);
    } catch (err) { showToast(err.message, true); }
  });

  $("fx-depot").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await send("/api/admin/depots", "POST", {
        annee, date_depot: $("fx-d-date").value, especes: parseEuros($("fx-d-esp").value), cheques: parseEuros($("fx-d-chq").value),
        nb_cheques: Number($("fx-d-nb").value) || 0, reference: $("fx-d-ref").value, note: $("fx-d-note").value,
      });
      ["fx-d-esp", "fx-d-chq", "fx-d-nb", "fx-d-ref", "fx-d-note"].forEach((id) => { $(id).value = ""; });
      showToast("Dépôt enregistré ✓");
      await load(annee);
    } catch (err) { showToast(err.status === 422 ? "Vérifiez la date et les montants." : err.message, true); }
  });

  document.body.addEventListener("click", async (e) => {
    try {
      if (e.target.closest("[data-cancel-depot]")) {
        const id = e.target.closest("tr").dataset.id;
        if (!confirm("Annuler ce dépôt (saisi par erreur) ? Il restera visible, barré.")) return;
        await send(`/api/admin/depots/${id}`, "DELETE");
        await load(annee);
      } else if (e.target.closest("#fx-close")) {
        if (!confirm(`Clôturer la tournée ${annee} ? Les dons, remises et dépôts de ${annee} ne pourront plus être modifiés.`)) return;
        const c = await send("/api/admin/fiscal/cloture", "POST", { annee });
        showToast(`Tournée ${annee} clôturée ✓ (empreinte ${c.sha256.slice(0, 12)}…)`);
        await load(annee);
      } else if (e.target.closest("[data-reopen]")) {
        const motif = prompt("Motif de la réouverture (il restera dans l'historique et le journal) :");
        if (!motif) return;
        await send(`/api/admin/fiscal/cloture/${e.target.closest("[data-reopen]").dataset.reopen}/reouvrir`, "POST", { motif });
        showToast("Année rouverte : pensez à la clôturer de nouveau.");
        await load(annee);
      }
    } catch (err) { showToast(err.status === 422 ? "Motif trop court (5 caractères au moins)." : err.message, true); }
  });

  load(new URLSearchParams(location.search).get("annee"));
})();
