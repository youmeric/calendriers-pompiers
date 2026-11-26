/* Site vitrine : envoi du formulaire « Demander une démo ». */
(() => {
  "use strict";
  const form = document.getElementById("v-form");
  const msg = document.getElementById("v-msg");
  const show = (text, ok) => { msg.textContent = text; msg.hidden = false; msg.className = `v-form-msg v-form-full ${ok ? "ok" : "ko"}`; };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.nom.trim() || !data.caserne.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email.trim())) {
      show("Indiquez votre nom, votre caserne et une adresse e-mail valide.", false);
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const r = await fetch("/api/vitrine/demande", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))).detail;
        throw new Error(typeof d === "string" ? d : "Vérifiez les champs du formulaire.");
      }
      form.reset();
      show("Merci ! Votre demande est bien partie. Nous vous recontactons par e-mail (ou par téléphone si vous l'avez indiqué) pour convenir d'une démonstration.", true);
    } catch (err) {
      show(err.message || "Envoi impossible, réessayez.", false);
    } finally {
      btn.disabled = false;
    }
  });
})();
