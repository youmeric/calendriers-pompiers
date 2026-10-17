/* Onglet « Suivi & dons » de l'admin : réglages (suivi, dons, SumUp), avancement et totaux
   par secteur, paiements carte en attente, export des dons. */
(() => {
  "use strict";
  const { escapeHtml, fetchJSON, showToast, sectorCode } = window.Common;
  const $ = (id) => document.getElementById(id);
  const euros = (v) => `${Number(v).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const MODE = { especes: "Espèces", cheque: "Chèque", cb: "Carte" };

  let onUnauthorized = () => {};
  let codes = new Map(); // sector_id -> {code, couleur}

  async function api(url, options) {
    try {
      return await fetchJSON(url, options);
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      if (err.status === 422) err.message = "Valeur refusée : vérifiez la saisie.";
      throw err;
    }
  }
  const put = (body) => api("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  function flashSaved() {
    const el = $("bilan-saved");
    el.hidden = false;
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
    clearTimeout(flashSaved.t);
    flashSaved.t = setTimeout(() => { el.hidden = true; }, 1800);
  }

  function applySettings(st, { fields = true } = {}) {
    $("suivi-toggle").checked = st.suivi_adresses;
    $("dons-toggle").checked = st.dons_actifs;
    $("dons-toggle").disabled = !st.suivi_adresses;
    $("sumup-toggle").checked = st.sumup_actif;
    $("sumup-toggle").disabled = !st.dons_actifs || !st.suivi_adresses;
    // les champs texte ne sont remplis qu'au chargement : une réponse ne doit pas effacer une saisie en cours
    if (fields) {
      $("sumup-key").value = st.sumup_affiliate_key;
      $("sumup-appid").value = st.sumup_app_id;
    }
    $("sumup-fields").hidden = !st.sumup_actif;
  }

  async function loadCodes() {
    const index = await fetchJSON("/api/communes");
    codes = new Map();
    const datas = await Promise.all(index.communes.map((c) => fetchJSON(`/api/communes/${encodeURIComponent(c.slug)}`)));
    datas.forEach((d) => d.sectors.forEach((s, i) => codes.set(s.id, { code: sectorCode(d.commune.nom, i), couleur: s.couleur, nom: s.nom })));
    $("bilan-title").textContent = `Suivi & dons — ${window.Common.tourneeTitle(index.annee)}`;
  }

  function tag(id) {
    const c = codes.get(id);
    return c ? `<b class="sector-code" style="background:${c.couleur}">${escapeHtml(c.code)}</b>` : "";
  }

  async function render() {
    const [settings, bilan] = await Promise.all([api("/api/admin/settings"), api("/api/admin/bilan")]);
    applySettings(settings);
    const t = bilan.totaux;
    const maisons = bilan.secteurs.reduce((n, s) => n + s.adresses, 0);
    const faites = bilan.secteurs.reduce((n, s) => n + s.counts.fait, 0);
    $("bilan-cards").innerHTML = `
      <div class="bilan-card"><span>Maisons faites</span><strong>${faites}<small>/${maisons}</small></strong></div>
      <div class="bilan-card total"><span>Total des dons</span><strong>${euros(t.total)}</strong><small>${t.nb} don${t.nb > 1 ? "s" : ""}${t.nb ? ` · moyenne ${euros(t.total / t.nb)}` : ""}</small></div>
      <div class="bilan-card"><span>Espèces</span><strong>${euros(t.especes)}</strong></div>
      <div class="bilan-card"><span>Chèques</span><strong>${euros(t.cheque)}</strong></div>
      <div class="bilan-card"><span>Carte</span><strong>${euros(t.cb)}</strong></div>`;
    $("bilan-attente").innerHTML = bilan.attente.length ? `
      <div class="warning warn"><div class="warning-body"><b>Paiements carte en attente</b> : SumUp n'a pas confirmé. Vérifiez dans l'appli SumUp puis validez ou annulez.
        ${bilan.attente.map((d) => `<div class="attente-row" data-id="${d.id}">${tag(d.sector_id)} ${euros(d.montant)} · ${escapeHtml(d.personne_nom)} · ${new Date(d.created_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
          <span><button type="button" class="btn small" data-act="ok">Payé</button> <button type="button" class="btn small" data-act="echec">Non payé</button></span></div>`).join("")}
      </div></div>` : "";
    $("bilan-body").innerHTML = bilan.secteurs.map((s) => {
      const done = s.counts.fait + s.counts.absent + s.counts.refus;
      const pct = s.adresses ? Math.round((done / s.adresses) * 100) : 0;
      return `<tr>
        <td><span class="bilan-sector">${tag(s.sector_id)} ${escapeHtml(s.nom)}</span><small class="hint">${escapeHtml(s.commune)}</small></td>
        <td><span class="bilan-progress"><span style="width:${pct}%;background:${s.couleur}"></span></span>
          <small>${s.counts.fait} faites · ${s.counts.absent} absents · ${s.counts.refus} refus / ${s.adresses}</small></td>
        <td>${s.totaux.nb}${s.totaux.attente ? ` <small class="wait">+${s.totaux.attente} en attente</small>` : ""}</td>
        <td>${euros(s.totaux.especes)}</td><td>${euros(s.totaux.cheque)}</td><td>${euros(s.totaux.cb)}</td>
        <td><b>${euros(s.totaux.total)}</b></td>
      </tr>`;
    }).join("") + `<tr class="bilan-total-row"><td>Total</td><td>${faites} faites / ${maisons}</td><td>${t.nb}</td>
      <td>${euros(t.especes)}</td><td>${euros(t.cheque)}</td><td>${euros(t.cb)}</td><td><b>${euros(t.total)}</b></td></tr>`;
  }

  // ---- réglages ----
  async function saveSetting(body) {
    try {
      applySettings(await put(body), { fields: false });
      flashSaved();
    } catch (err) {
      showToast(err.message, true);
      render().catch(() => {});
    }
  }
  $("dons-toggle").addEventListener("change", () => saveSetting({ dons_actifs: $("dons-toggle").checked }));
  $("sumup-toggle").addEventListener("change", () => saveSetting({ sumup_actif: $("sumup-toggle").checked }));
  $("sumup-key").addEventListener("change", () => saveSetting({ sumup_affiliate_key: $("sumup-key").value }));
  $("sumup-appid").addEventListener("change", () => saveSetting({ sumup_app_id: $("sumup-appid").value }));
  window.addEventListener("suivi-change", () => render().catch(() => {}));

  // ---- paiements en attente ----
  $("bilan-attente").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.closest(".attente-row").dataset.id;
    const tx = btn.dataset.act === "ok" ? (prompt("N° de transaction SumUp (facultatif) :") || "") : "";
    try {
      await api(`/api/equipe/dons/${id}/statut`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ statut: btn.dataset.act, tx_code: tx }),
      });
      flashSaved();
      await render();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $("bilan-refresh").addEventListener("click", () => render().catch((err) => showToast(err.message, true)));

  // ---- export ----
  $("bilan-export").addEventListener("click", async () => {
    try {
      const { annee, dons } = await api("/api/admin/dons");
      // guillemets doublés, et pas de formule Excel cachée dans un nom ou une note (=, +, -, @)
      const cell = (v) => `"${String(v ?? "").replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;
      const statut = { ok: "Payé", attente: "En attente", echec: "Échoué" };
      const rows = [["Date", "Secteur", "Adresse", "Montant", "Moyen", "Statut", "N° transaction", "Saisi par", "Note"]];
      for (const d of dons) {
        rows.push([new Date(d.created_at).toLocaleString("fr-FR"), codes.get(d.sector_id)?.code || d.sector_id, d.adresse,
          String(d.montant).replace(".", ","), MODE[d.mode], statut[d.statut], d.tx_code, d.personne_nom, d.note]);
      }
      const csv = "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      a.download = `dons-tournee-${annee}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  window.Bilan = {
    async open(opts = {}) {
      if (opts.onUnauthorized) onUnauthorized = opts.onUnauthorized;
      await loadCodes();
      await render();
    },
  };
})();
