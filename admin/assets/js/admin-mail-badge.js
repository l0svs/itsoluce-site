/**
 * Pastille « Messages » de la navigation : nombre de mails non lus dans
 * « Reçus ». Chargé sur toutes les pages de l'ERP sauf Messages, qui tient
 * son propre compteur à jour.
 *
 * Autonome, comme admin-palette.js : même client Supabase (clé publique anon,
 * session partagée par le navigateur). Un compte sans accès à Messages ne
 * voit simplement pas la pastille : la lecture est refusée par RLS.
 */
(function () {
  'use strict';
  var SB_URL = 'https://esltsiutcjcwdbhkkvms.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVzbHRzaXV0Y2pjd2RiaGtrdm1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3NjM2OTEsImV4cCI6MjA5NzMzOTY5MX0.Sl2cdnqEr7VSBeq1wwMBpfQW9yBB0IG9RkOiZi9GXvo';
  var sbPromise = null;

  function client() {
    if (!sbPromise) {
      sbPromise = import('https://esm.sh/@supabase/supabase-js@2')
        .then(function (mod) { return mod.createClient(SB_URL, SB_KEY); })
        .catch(function () { return null; });
    }
    return sbPromise;
  }

  function afficher(n) {
    document.querySelectorAll('#nb-mail').forEach(function (el) {
      el.textContent = n;
      el.style.display = n ? '' : 'none';
    });
  }

  function compter() {
    if (!document.getElementById('nb-mail') || document.hidden) return;
    client().then(function (sb) {
      if (!sb) return;
      sb.auth.getSession().then(function (r) {
        if (!r.data || !r.data.session) return;
        sb.from('mails').select('id', { count: 'exact', head: true })
          .eq('dossier', 'INBOX').eq('lu', false)
          .then(function (res) { if (!res.error) afficher(res.count || 0); });
      });
    });
  }

  // Après le chargement de la page (la session est rafraîchie par la page).
  setTimeout(compter, 1500);
  setInterval(compter, 120000);
})();
