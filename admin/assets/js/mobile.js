/* IT Soluce ERP — comportements téléphone communs à toutes les pages.
   Sur téléphone uniquement (≤ 640 px) :
   - pose la classe « m-modal » sur <html> tant qu'une fenêtre ou un panneau
     occupe l'écran : la barre d'onglets du bas se retire (mobile.css) et ne
     recouvre plus les boutons de la fenêtre ;
   - ferme le menu latéral dès qu'on touche un lien. */
(function () {
  if (!window.matchMedia) return;
  var mq = window.matchMedia('(max-width:640px)');
  var FENETRES = '.mo-ov,.tr-ov,.email-overlay,.pdf-overlay,.modal-fond,.cmd-ov,.calc-modal,.qr-plein,#rl-ov,' +
    '.panel,.fiche,.plan-det,[role="dialog"],[class*="overlay"],[class*="modal"]';
  var EXCLUS = /(^|\s)(mobile-overlay|mobile-nav|mobile-bottombar)(\s|$)/;

  function ouverte(e) {
    if (EXCLUS.test(e.className || '')) return false;
    var s = getComputedStyle(e);
    if (s.position !== 'fixed' || s.display === 'none' || s.visibility === 'hidden' ||
        parseFloat(s.opacity || '1') < 0.05 || s.pointerEvents === 'none') return false;
    var r = e.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
    return r.width > W * 0.6 && r.height > H * 0.4 && r.left < W / 2 && r.right > W / 2 && r.top < H && r.bottom > 0;
  }
  var prevu = 0;
  function maj() {
    prevu = 0;
    var on = false;
    if (mq.matches) {
      var l = document.querySelectorAll(FENETRES);
      for (var i = 0; i < l.length && !on; i++) on = ouverte(l[i]);
    }
    document.documentElement.classList.toggle('m-modal', on);
  }
  function plan() { if (!prevu) prevu = requestAnimationFrame(maj); }

  function demarrer() {
    new MutationObserver(plan).observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'],
    });
    window.addEventListener('resize', plan);
    document.addEventListener('transitionend', plan, true);
    document.addEventListener('animationend', plan, true);
    plan();
    // Menu latéral : se ferme dès qu'on choisit une page.
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('.mobile-nav .nl');
      if (a && typeof window.closeMobileNav === 'function') window.closeMobileNav();
    }, true);
  }
  if (document.body) demarrer(); else document.addEventListener('DOMContentLoaded', demarrer);
})();
