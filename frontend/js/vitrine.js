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

/* Bouton « Demander une démo » collant (téléphone) et apparitions au défilement. */
(() => {
  "use strict";
  const sticky = document.getElementById("v-sticky");
  const hero = document.querySelector(".v-hero");
  const contact = document.getElementById("contact");
  if (sticky && hero && contact && "IntersectionObserver" in window) {
    const seen = { hero: true, contact: false };
    const update = () => { sticky.hidden = seen.hero || seen.contact; };
    new IntersectionObserver(([e]) => { seen.hero = e.isIntersecting; update(); }).observe(hero);
    new IntersectionObserver(([e]) => { seen.contact = e.isIntersecting; update(); }).observe(contact);
  }
  // pas d'animation pour les robots (captures, référencement) ni si le téléphone demande moins de mouvement
  if (navigator.webdriver || !("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const items = document.querySelectorAll("main section h2, .v-pillar, .v-price-card, .v-compare-col, .v-feature-media, .v-feature-image, .v-brand-phones figure, .v-finance-grid article, .v-roles-grid article, .v-timeline article, .v-security-grid article, .v-form-card");
  document.documentElement.classList.add("v-reveal-on");
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
  }), { rootMargin: "0px 0px -8% 0px" });
  items.forEach((el, i) => { el.classList.add("v-reveal"); el.style.transitionDelay = `${(i % 4) * 70}ms`; io.observe(el); });
})();

/* Tarifs : « Choisir cette formule » la présélectionne dans le formulaire de demande. */
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-offre]");
  const select = document.querySelector('#v-form select[name="offre"]');
  if (btn && select) select.value = btn.dataset.offre;
});
