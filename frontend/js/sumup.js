/* Retour de l'appli SumUp : elle rouvre /sumup-retour/<id>?smp-status=...&smp-tx-code=...
   On transmet le résultat au serveur, qui valide (ou non) le don en attente. */
(async () => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const foreignId = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "") || params.get("foreign-tx-id") || "";
  const status = params.get("smp-status") || "";
  const show = (icon, title, detail, cls) => {
    $("sumup-icon").textContent = icon;
    $("sumup-icon").className = `sumup-icon ${cls || ""}`;
    $("sumup-title").textContent = title;
    $("sumup-detail").textContent = detail || "";
  };
  try {
    const resp = await fetch("/api/sumup/retour", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foreign_id: foreignId, status, tx_code: params.get("smp-tx-code") || "" }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    const amount = `${Number(data.montant).toLocaleString("fr-FR", { minimumFractionDigits: 2 })} €`;
    if (data.statut === "ok") {
      show("✓", `Paiement accepté : ${amount}`, "Merci ! Le don est enregistré pour cette maison.", "ok");
    } else if (status === "invalidstate") {
      show("!", "SumUp n'était pas prêt", "Ouvrez l'appli SumUp, connectez-vous et vérifiez le lecteur, puis recommencez.", "fail");
    } else {
      show("✕", `Paiement non abouti (${amount})`, params.get("smp-message") || "Aucun montant n'a été encaissé. Vous pouvez recommencer.", "fail");
    }
    const back = $("sumup-back");
    back.href = "/equipe#caisse";
    back.hidden = false;
  } catch (err) {
    show("!", "Résultat non enregistré", `${err.message}. Vérifiez le paiement dans l'appli SumUp et saisissez-le à la main si besoin.`, "fail");
    $("sumup-back").href = "/equipe#caisse";
    $("sumup-back").hidden = false;
  }
})();
