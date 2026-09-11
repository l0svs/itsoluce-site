/**
 * Navigation partagée de l'ERP IT Soluce.
 *
 * Avant ce fichier, chaque page admin (15 fichiers) recopiait intégralement :
 *  - une nav horizontale déroulante (.hnav), à déplier groupe par groupe ;
 *  - une sidebar verticale IDENTIQUE mais jamais affichée (display:none codé
 *    en dur), qui ne servait qu'à être clonée pour construire le menu mobile
 *    plein écran ;
 *  - le menu du bas mobile (.mobile-bottombar) ;
 *  - la logique JS associée (ouverture des menus déroulants, menu mobile,
 *    marquage de la page active).
 * Résultat : ajouter/renommer une page demandait de modifier 15 fichiers, et
 * ça avait déjà dérivé (ex. libellé du fil d'Ariane différent d'une page à
 * l'autre).
 *
 * Ce fichier est maintenant la SEULE source de vérité pour la structure de
 * navigation, et va plus loin que la v1 :
 *  - Desktop (≥900px) : la sidebar (.nl / .nl-group, déjà stylée dans chaque
 *    page mais jamais utilisée) devient la nav permanente, groupes toujours
 *    visibles — plus besoin de déplier un menu pour voir les pages d'un
 *    groupe. L'ancienne barre horizontale à onglets déroulants disparaît.
 *  - Mobile (<900px) : inchangé (hamburger → menu plein écran + barre du bas).
 *
 * Utilisation dans une page : le point de montage doit être le premier
 * enfant de .layout (pour que la sidebar s'insère au bon endroit) :
 *   <div class="layout">
 *   <div id="admin-nav-mount"></div>
 *   <script src="/admin/assets/js/admin-nav.js"></script>
 *   <div class="content" id="mainContent">...
 */
(function () {
  'use strict';

  var ICONS = {
    dashboard: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    clients: '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>',
    devis: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    factures: '<svg viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
    demandes: '<svg viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
    diagnostics: '<svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    reparations: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    stock: '<svg viewBox="0 0 24 24"><path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>',
    catalogue: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    commandes: '<svg viewBox="0 0 24 24"><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
    fournisseurs: '<svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    prestations: '<svg viewBox="0 0 24 24"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    planning: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.17-2.82H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1.17-2.82V2a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 2.82 1.17H22a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
  };

  var DASHBOARD = { key: 'dashboard', href: '/admin/dashboard.html', label: 'Dashboard', icon: 'dashboard' };

  // Structure de navigation — modifier une page (ajout, renommage, ordre) se
  // fait UNIQUEMENT ici, plus dans 15 fichiers.
  var GROUPS = [
    { name: 'Commercial', items: [
      { key: 'clients', href: '/admin/clients.html', label: 'Clients', icon: 'clients', badge: 'nc' },
      { key: 'devis', href: '/admin/devis.html', label: 'Devis', icon: 'devis' },
      { key: 'factures', href: '/admin/factures.html', label: 'Factures', icon: 'factures' }
    ]},
    { name: 'Technique', items: [
      { key: 'demandes', href: '/admin/demandes.html', label: 'Demandes', icon: 'demandes', badge: 'nb-dem' },
      { key: 'diagnostics', href: '/admin/diagnostics.html', label: 'Diagnostics', icon: 'diagnostics' },
      // Garanties a été fusionné ici : ce n'était pas une entité propre mais
      // un filtre de la table `reparations` (statut pret/rendu) — voir
      // l'onglet "Sous garantie" de la page Réparations.
      { key: 'reparations', href: '/admin/reparations.html', label: 'Réparations', icon: 'reparations', badge: 'nb-rep' }
    ]},
    { name: 'Gestion', items: [
      { key: 'stock', href: '/admin/stock.html', label: 'Stock', icon: 'stock', badge: 'nb-alert', badgeWarn: true, badgeDefault: '—' },
      { key: 'catalogue', href: '/admin/catalogue.html', label: 'Catalogue Foneday', icon: 'catalogue' },
      { key: 'commandes-foneday', href: '/admin/commandes-foneday.html', label: 'Commandes Foneday', icon: 'commandes' },
      { key: 'fournisseurs', href: '/admin/fournisseurs.html', label: 'Fournisseurs', icon: 'fournisseurs', badge: 'nb-four', badgeDefault: '—' },
      { key: 'prestations', href: '/admin/prestations.html', label: 'Prestations', icon: 'prestations' }
    ]},
    { name: 'Organisation', items: [
      { key: 'planning', href: '/admin/planning.html', label: 'Planning', icon: 'planning' },
      { key: 'settings', href: '/admin/settings.html', label: 'Paramètres', icon: 'settings' }
    ]}
  ];

  // Les 5 raccourcis de la barre du bas (mobile uniquement) — volontairement
  // une sélection restreinte, inchangée par rapport à l'existant.
  var BOTTOMBAR = [
    { key: 'dashboard', href: '/admin/dashboard.html', label: 'Accueil', icon: 'dashboard' },
    { key: 'reparations', href: '/admin/reparations.html', label: 'Répar.', icon: 'reparations' },
    { key: 'stock', href: '/admin/stock.html', label: 'Stock', icon: 'stock' },
    { key: 'catalogue', href: '/admin/catalogue.html', label: 'Catalogue', icon: 'catalogue' },
    { key: 'clients', href: '/admin/clients.html', label: 'Clients', icon: 'clients' }
  ];

  var currentPage = (location.pathname.split('/').pop() || '').replace('.html', '') || 'dashboard';

  // Exposé pour la palette de commandes (admin-palette.js) : liste plate des
  // pages, une seule source pour les deux fichiers.
  window.ADMIN_PAGES = [DASHBOARD].concat(GROUPS.reduce(function (acc, g) { return acc.concat(g.items); }, []))
    .map(function (it) { return { key: it.key, href: it.href, label: it.label }; });

  function badgeHtml(item) {
    if (!item.badge) return '';
    var cls = item.badgeWarn ? 'nc w' : 'nc';
    var val = item.badgeDefault != null ? item.badgeDefault : '0';
    return ' <span class="' + cls + '" id="' + item.badge + '">' + val + '</span>';
  }

  // ---- Sidebar desktop permanente (remplace l'ancienne nav à onglets déroulants) ----
  function buildSidebarNav() {
    var html = '<a href="' + DASHBOARD.href + '" class="nl' + (currentPage === DASHBOARD.key ? ' active' : '') + '">' +
      ICONS[DASHBOARD.icon] + DASHBOARD.label + '</a>';
    GROUPS.forEach(function (group) {
      html += '<div class="nl-group">' + group.name + '</div>';
      group.items.forEach(function (it) {
        html += '<a href="' + it.href + '" class="nl' + (it.key === currentPage ? ' active' : '') + '">' +
          ICONS[it.icon] + it.label + badgeHtml(it) + '</a>';
      });
    });
    html += '<div class="sf">IT Soluce ERP · v1.0</div>';
    return html;
  }

  function buildBottombar() {
    var html = '<div class="mobile-bottombar"><div class="mobile-bottombar-inner">';
    BOTTOMBAR.forEach(function (it) {
      html += '<a href="' + it.href + '" class="mbb-item' + (it.key === currentPage ? ' active' : '') + '" data-page="' + it.key + '">' +
        ICONS[it.icon] + it.label + '</a>';
    });
    html += '</div></div>';
    return html;
  }

  // ---- Montage ----
  // Le point de montage est le premier enfant de .layout : au moment où ce
  // script s'exécute (synchrone, pendant le parsing), la balise <div
  // class="layout"> qui l'englobe existe déjà dans le DOM même si elle n'est
  // pas encore refermée dans le HTML — on peut donc s'y insérer directement.
  var mount = document.getElementById('admin-nav-mount');
  if (mount) {
    var aside = document.createElement('aside');
    aside.className = 'sidebar';
    aside.innerHTML = buildSidebarNav();
    mount.replaceWith(aside);
    // La règle .sidebar{display:none} de chaque page cache l'ancien clone
    // mobile ; ce style inline (priorité supérieure) l'affiche en permanence
    // à partir de la largeur où l'ancienne .hnav apparaissait (900px), et la
    // masque en dessous — le mobile garde le hamburger + la barre du bas.
    var mq = window.matchMedia('(min-width:900px)');
    var applySidebarVisibility = function () { aside.style.display = mq.matches ? 'flex' : 'none'; };
    applySidebarVisibility();
    (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(applySidebarVisibility);
  }
  document.body.insertAdjacentHTML('beforeend', buildBottombar());

  // ---- Menu mobile plein écran (construit directement, plus de clone de sidebar) ----
  window.openMobileNav = function () {
    var ov = document.getElementById('mobileOverlay');
    var mnav = document.getElementById('mobileNav');
    if (!mnav) {
      ov = document.createElement('div');
      ov.id = 'mobileOverlay';
      ov.className = 'mobile-overlay';
      ov.onclick = window.closeMobileNav;
      mnav = document.createElement('div');
      mnav.id = 'mobileNav';
      mnav.className = 'mobile-nav';
      var head = document.createElement('div');
      head.className = 'mobile-nav-head';
      head.innerHTML = '<img src="https://itsoluce.be/favicon_io/android-chrome-512x512.png" alt="IT Soluce"/><button class="mobile-nav-close" onclick="closeMobileNav()">&times;</button>';
      mnav.appendChild(head);
      var body = document.createElement('div');
      body.innerHTML = buildSidebarNav();
      mnav.appendChild(body);
      document.body.appendChild(ov);
      document.body.appendChild(mnav);
    }
    requestAnimationFrame(function () { ov.classList.add('open'); mnav.classList.add('open'); });
  };
  window.closeMobileNav = function () {
    var ov = document.getElementById('mobileOverlay');
    var mnav = document.getElementById('mobileNav');
    if (ov) ov.classList.remove('open');
    if (mnav) mnav.classList.remove('open');
  };

  // ---- Pré-remplissage générique de la recherche depuis l'URL (?q=) ----
  // Utilisé par la palette de commandes (admin-palette.js) pour renvoyer vers
  // la page de liste correspondante avec la recherche déjà faite. Générique :
  // s'applique à toute page qui a un champ #searchInput avec un filtrage sur
  // l'événement "input" (déjà le cas de Clients, Devis, Factures,
  // Réparations, Demandes, Diagnostics, Stock, Fournisseurs) ; ne fait rien
  // sinon.
  var q = new URLSearchParams(location.search).get('q');
  if (q) {
    document.addEventListener('DOMContentLoaded', function () {
      var input = document.getElementById('searchInput');
      if (input) {
        input.value = q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }
})();
