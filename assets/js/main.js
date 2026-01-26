// Mobile menu
const burger = document.querySelector("[data-burger]");
const mobilePanel = document.querySelector("[data-mobilepanel]");

if (burger && mobilePanel) {
  burger.addEventListener("click", () => {
    const isOpen = mobilePanel.classList.toggle("open");
    burger.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });

  mobilePanel.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => mobilePanel.classList.remove("open"));
  });
}

// Navbar becomes less transparent on scroll
(function navTransparency(){
  const nav = document.querySelector("[data-nav]");
  if (!nav) return;

  const onScroll = () => {
    nav.classList.toggle("is-scrolled", window.scrollY > 10);
  };

  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
})();

// Active link highlight (supports #services / #contact + pages)
(function activeNav(){
  const links = Array.from(document.querySelectorAll("[data-navlinks] a"));
  if (!links.length) return;

  const markActive = () => {
    const hash = window.location.hash || "";
    links.forEach(l => l.classList.remove("active"));

    if (hash) {
      const match = links.find(a => a.getAttribute("href") === hash);
      if (match) match.classList.add("active");
      return;
    }

    const file = window.location.pathname.split("/").pop() || "index.html";
    links.forEach((link) => {
      const href = link.getAttribute("href");
      if (href === file) link.classList.add("active");
    });
  };

  markActive();
  window.addEventListener("hashchange", markActive);
})();

// HERO background carousel (every 5s, infinite)
(function heroCarousel(){
  const hero = document.querySelector("[data-hero-carousel]");
  if (!hero) return;

  const slides = Array.from(hero.querySelectorAll("[data-slide]"));
  if (slides.length < 2) return;

  // Preload images
  const urls = slides.map(s => {
    const bg = s.style.backgroundImage || "";
    return bg.replace(/^url\(["']?/, "").replace(/["']?\)$/, "");
  });
  urls.forEach((url) => {
    const img = new Image();
    img.src = url;
  });

  let i = slides.findIndex(s => s.classList.contains("is-active"));
  if (i < 0) i = 0;

  setInterval(() => {
    slides[i].classList.remove("is-active");
    i = (i + 1) % slides.length;
    slides[i].classList.add("is-active");
  }, 5000);
})();

// LEGAL MODAL (Mentions/Privacy/Cookies/Terms)
(function legalModal(){
  const modal = document.querySelector("[data-legal-modal]");
  const content = document.querySelector("[data-legal-content]");
  const title = document.getElementById("legalTitle");

  if (!modal || !content || !title) return;

  const legalTexts = {
    mentions: {
      title: "Mentions légales",
      html: `
        <h4>1) Éditeur du site</h4>
        <p><strong>IT Soluce</strong> (activité de réparation informatique).</p>
        <p>
          Contact : <a href="mailto:contact@itsoluce.be">contact@itsoluce.be</a><br/>
          Zone : Belgique (interventions à domicile et/ou dans le véhicule de l’intervenant, sur rendez-vous).
        </p>
        <p>
          <strong>À compléter dès que disponible :</strong><br/>
          • Numéro d’entreprise (BCE) : <em>[à compléter]</em><br/>
          • TVA : <em>[à compléter si assujetti]</em><br/>
          • Adresse de l’établissement / siège : <em>[à compléter]</em>
        </p>

        <h4>2) Hébergement</h4>
        <p>Hébergeur : <em>[à compléter]</em></p>

        <h4>3) Propriété intellectuelle</h4>
        <p>
          Les contenus (textes, visuels, logo, design) sont protégés. Toute reproduction ou réutilisation sans autorisation est interdite.
        </p>

        <h4>4) Contact</h4>
        <p>Pour toute question : <a href="mailto:contact@itsoluce.be">contact@itsoluce.be</a></p>

        <div class="legalNote">
          Note : ces mentions doivent être complétées avec ton numéro BCE/TVA et l’adresse dès que ton activité est enregistrée.
        </div>
      `
    },

    privacy: {
      title: "Politique de confidentialité (RGPD)",
      html: `
        <h4>1) Qui traite vos données ?</h4>
        <p>
          Responsable du traitement : <strong>IT Soluce</strong>.<br/>
          Contact : <a href="mailto:contact@itsoluce.be">contact@itsoluce.be</a>
        </p>

        <h4>2) Quelles données collectées ?</h4>
        <ul>
          <li>Données d’identification : nom/prénom (si fourni), email, téléphone (si fourni).</li>
          <li>Données liées à la demande : type d’appareil, description de panne, messages d’erreur.</li>
          <li>Données techniques minimales : logs techniques nécessaires au diagnostic (si intervention).</li>
        </ul>

        <h4>3) Pourquoi (finalités) ?</h4>
        <ul>
          <li>Répondre à votre demande, établir un devis, planifier une intervention.</li>
          <li>Exécuter le service (diagnostic, réparation, configuration).</li>
          <li>Suivi après intervention (garantie, questions, facturation).</li>
        </ul>

        <h4>4) Base légale</h4>
        <ul>
          <li>Exécution d’un contrat / mesures précontractuelles (devis, rendez-vous).</li>
          <li>Intérêt légitime (sécurité, prévention fraude, qualité du service).</li>
          <li>Obligations légales (facturation/comptabilité) lorsque applicable.</li>
        </ul>

        <h4>5) Durées de conservation</h4>
        <ul>
          <li>Demandes/devis non aboutis : en général jusqu’à <strong>12 mois</strong>.</li>
          <li>Dossiers clients/interventions : durée nécessaire au suivi + obligations comptables si facturation.</li>
        </ul>

        <h4>6) Destinataires</h4>
        <p>
          Vos données ne sont pas vendues. Elles peuvent être partagées uniquement avec :
        </p>
        <ul>
          <li>Fournisseurs/partenaires nécessaires (pièces, garanties) si requis.</li>
          <li>Prestataires techniques (hébergement, outils) strictement nécessaires.</li>
        </ul>

        <h4>7) Vos droits</h4>
        <p>
          Vous pouvez demander l’accès, la rectification, l’effacement, la limitation, l’opposition, et la portabilité selon le RGPD.
          Contact : <a href="mailto:contact@itsoluce.be">contact@itsoluce.be</a>
        </p>

        <h4>8) Sécurité</h4>
        <p>
          Des mesures raisonnables sont mises en place pour protéger les données (accès limité, appareils sécurisés).
          Les identifiants/mots de passe fournis par le client ne sont pas conservés au-delà de l’intervention.
        </p>
      `
    },

    cookies: {
      title: "Politique cookies",
      html: `
        <h4>1) C’est quoi un cookie ?</h4>
        <p>Un cookie est un petit fichier stocké sur votre appareil pour assurer le fonctionnement du site ou mesurer l’audience.</p>

        <h4>2) Cookies utilisés sur ce site</h4>
        <p>
          <strong>Actuellement :</strong> ce site peut fonctionner <strong>sans cookies non essentiels</strong>.
          Si vous activez plus tard des outils de mesure (ex: analytics), une bannière de consentement sera mise en place.
        </p>

        <h4>3) Gestion</h4>
        <p>
          Vous pouvez supprimer/bloquer les cookies via les paramètres de votre navigateur.
        </p>

        <div class="legalNote">
          Si tu ajoutes Google Analytics / Meta Pixel / etc, dis-moi : je te mets une vraie bannière “consent” RGPD propre.
        </div>
      `
    },

    terms: {
      title: "Conditions générales de service (Réparation informatique)",
      html: `
        <h4>1) Objet</h4>
        <p>
          Les présentes conditions encadrent les prestations de diagnostic, réparation, optimisation, sécurisation,
          installation et assistance informatique réalisées par <strong>IT Soluce</strong>, en Belgique,
          à domicile et/ou dans le véhicule de l’intervenant, sur rendez-vous.
        </p>

        <h4>2) Devis & accord</h4>
        <ul>
          <li>Un devis (ou une estimation) est communiqué avant toute intervention payante.</li>
          <li>L’intervention démarre uniquement après accord du client (écrit ou oral confirmé).</li>
        </ul>

        <h4>3) Diagnostic</h4>
        <ul>
          <li>Le diagnostic peut être facturé si indiqué avant prise en charge.</li>
          <li>Si le client refuse la réparation après diagnostic, le diagnostic reste dû (si annoncé).</li>
        </ul>

        <h4>4) Sauvegarde & données</h4>
        <ul>
          <li>Le client reste responsable de ses sauvegardes.</li>
          <li>Une sauvegarde peut être proposée (payante ou incluse selon cas), à valider avant exécution.</li>
          <li>IT Soluce n’est pas responsable d’une perte de données due à l’état initial du système,
              à une défaillance matérielle ou à l’absence de sauvegarde, sauf faute lourde/volontaire.</li>
        </ul>

        <h4>5) Accès, mots de passe</h4>
        <ul>
          <li>Si des identifiants sont nécessaires, le client peut les fournir uniquement pour la durée de l’intervention.</li>
          <li>Les identifiants ne sont pas conservés après la prestation.</li>
        </ul>

        <h4>6) Pièces, garanties & compatibilité</h4>
        <ul>
          <li>Les pièces peuvent être neuves ou reconditionnées selon accord.</li>
          <li>La garantie sur pièces dépend du fournisseur/fabricant (conditions applicables).</li>
          <li>Une garantie de main d’œuvre peut être appliquée sur la même intervention, selon ce qui est annoncé au devis.</li>
          <li>Les problèmes indépendants de la réparation (nouvelle panne, logiciel tiers, obsolescence) ne sont pas couverts.</li>
        </ul>

        <h4>7) Intervention à domicile / dans le véhicule</h4>
        <ul>
          <li>Le client garantit un environnement raisonnablement sûr et accessible pour l’intervention.</li>
          <li>En cas de conditions non adaptées (sécurité, hygiène, espace), IT Soluce peut interrompre/refuser l’intervention.</li>
        </ul>

        <h4>8) Limitation de responsabilité</h4>
        <ul>
          <li>IT Soluce est responsable des dommages directs causés par une faute prouvée dans le cadre de la prestation.</li>
          <li>IT Soluce n’est pas responsable des dommages indirects (perte d’exploitation, perte de revenus, etc.).</li>
          <li>Les limites s’appliquent dans la mesure permise par le droit belge.</li>
        </ul>

        <h4>9) Droit de rétractation (consommateurs)</h4>
        <p>
          Si la prestation est conclue à distance ou hors établissement, un droit de rétractation peut s’appliquer.
          Si le client demande expressément de commencer avant la fin du délai légal, des règles spécifiques peuvent limiter ce droit.
        </p>

        <h4>10) Paiement</h4>
        <p>Modalités (cash/bancontact/virement) : selon accord. Le paiement est dû selon les conditions annoncées au devis.</p>

        <h4>11) Litiges & droit applicable</h4>
        <p>Le droit belge est applicable. En cas de litige, une solution amiable est privilégiée avant action.</p>

        <div class="legalNote">
          Astuce : dès que tu as ton statut officiel (BCE/TVA), on ajuste 2 lignes + on est carré.
        </div>
      `
    }
  };

  const openBtns = document.querySelectorAll("[data-legal-open]");
  const closeBtns = document.querySelectorAll("[data-legal-close]");

  const open = (key) => {
    const item = legalTexts[key];
    if (!item) return;

    title.textContent = item.title;
    content.innerHTML = item.html;

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  };

  const close = () => {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  };

  openBtns.forEach(btn => {
    btn.addEventListener("click", () => open(btn.getAttribute("data-legal-open")));
  });

  closeBtns.forEach(btn => btn.addEventListener("click", close));

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
})();