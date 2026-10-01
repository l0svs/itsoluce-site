/**
 * Pastilles de la navigation, identiques sur toutes les pages de l'ERP :
 *  - Demandes    : demandes du site pas encore vues (ni transformées en dossier)
 *  - Réparations : dossiers ouverts (ni rendus, ni annulés, ni non réparables)
 *  - Stock       : pièces en rupture ou sous le seuil d'alerte
 *  - Messages    : mails non lus dans « Reçus »
 * Une pastille à 0 est masquée. Les pages Demandes, Réparations, Stock,
 * Messages et le Dashboard mettent aussi la leur à jour après chaque
 * modification, avec les mêmes règles.
 *
 * Autonome, comme admin-palette.js : même client Supabase (clé publique anon,
 * session partagée par le navigateur). Un compte sans accès à une page ne voit
 * simplement pas sa pastille : la lecture est refusée par RLS.
 */
(function () {
  'use strict';
  var SB_URL = 'https://esltsiutcjcwdbhkkvms.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVzbHRzaXV0Y2pjd2RiaGtrdm1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3NjM2OTEsImV4cCI6MjA5NzMzOTY5MX0.Sl2cdnqEr7VSBeq1wwMBpfQW9yBB0IG9RkOiZi9GXvo';
  var CLOS = ['rendu', 'annule', 'non_reparable'];
  var sbPromise = null;

  function client() {
    if (!sbPromise) {
      sbPromise = import('https://esm.sh/@supabase/supabase-js@2')
        .then(function (mod) { return mod.createClient(SB_URL, SB_KEY); })
        .catch(function () { return null; });
    }
    return sbPromise;
  }

  function afficher(id, n) {
    document.querySelectorAll('#' + id).forEach(function (el) {
      el.textContent = n;
      el.style.display = n ? '' : 'none';
    });
  }

  /* Un compte d'équipe ne voit que ses pages : chaque page retire du menu
     les liens interdits. Une rubrique restée sans lien est masquée. */
  function masquerRubriquesVides() {
    document.querySelectorAll('.nl-group').forEach(function (g) {
      var el = g.nextElementSibling, lien = false;
      while (el && !el.classList.contains('nl-group') && !el.classList.contains('sf')) {
        if (el.classList.contains('nl')) { lien = true; break; }
        el = el.nextElementSibling;
      }
      g.style.display = lien ? '' : 'none';
    });
  }

  function compter() {
    masquerRubriquesVides();
    if (document.hidden) return;
    client().then(function (sb) {
      if (!sb) return;
      sb.auth.getSession().then(function (r) {
        if (!r.data || !r.data.session) return;
        sb.from('demandes_formulaire').select('id', { count: 'exact', head: true })
          .eq('vue', false).is('converti_reparation_id', null)
          .then(function (res) { if (!res.error) afficher('nb-dem', res.count || 0); });
        sb.from('reparations').select('id', { count: 'exact', head: true })
          .not('statut', 'in', '(' + CLOS.join(',') + ')')
          .then(function (res) { if (!res.error) afficher('nb-rep', res.count || 0); });
        // Deux colonnes à comparer : impossible en filtre, on lit les quantités.
        sb.from('stock').select('quantite,seuil_alerte').limit(5000)
          .then(function (res) {
            if (res.error) return;
            afficher('nb-alert', (res.data || []).filter(function (p) {
              return (Number(p.quantite) || 0) <= (Number(p.seuil_alerte) || 0);
            }).length);
          });
        sb.from('mails').select('id', { count: 'exact', head: true })
          .eq('dossier', 'INBOX').eq('lu', false)
          .then(function (res) { if (!res.error) afficher('nb-mail', res.count || 0); });
      });
    });
  }

  // Après le chargement de la page (la session est rafraîchie par la page).
  setTimeout(compter, 1500);
  setInterval(compter, 120000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) compter(); });
})();
