/**
 * Parrainage — bandeau commun aux pages Factures et Devis.
 *
 * Règles (appliquées en base par le déclencheur parrainage_facture) :
 *  - un client parrainé reçoit UNE réduction de bienvenue, sur sa première
 *    facture qui la contient ;
 *  - le parrain gagne sa récompense quand la facture de son filleul est payée ;
 *  - le parrain utilise ses réductions sur ses propres factures, dans la
 *    limite de son solde.
 * Les réductions sont des lignes négatives marquées { parrainage: 'filleul' }
 * ou { parrainage: 'parrain' } : elles restent visibles sur la facture.
 */
(function () {
  var EUR = new Intl.NumberFormat('fr-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function eur(v) { return EUR.format(Number(v) || 0) + ' €'; }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function etat(sb, clientId) {
    if (!clientId) return null;
    var rc = await sb.from('clients').select('id,nom,code_parrainage,parrain_id').eq('id', clientId).maybeSingle();
    if (rc.error || !rc.data) return null;
    var c = rc.data, parrain = null;
    if (c.parrain_id) {
      var rp = await sb.from('clients').select('id,nom,code_parrainage').eq('id', c.parrain_id).maybeSingle();
      parrain = rp.data || null;
    }
    var rm = await sb.from('parrainage_mouvements').select('type,montant').eq('client_id', clientId);
    var mv = rm.error ? [] : (rm.data || []);
    var solde = mv.filter(function (x) { return ['gain', 'utilisation', 'annulation'].indexOf(x.type) >= 0; })
      .reduce(function (t, x) { return t + Number(x.montant || 0); }, 0);
    return {
      client: c, parrain: parrain,
      remiseUtilisee: mv.some(function (x) { return x.type === 'remise_filleul'; }),
      solde: Math.round(solde * 100) / 100
    };
  }

  /**
   * opts : { el, etat, devis, emis, actif, remiseFilleul, minimum, lignes, sousTotal, codeDemande, ajouter(desc, montant, tag) }
 * codeDemande : code saisi par le visiteur dans le formulaire du site ; le
 * client est lié à son parrain par la base quand la demande devient un devis.
   */
  function rendre(opts) {
    var el = opts.el;
    if (!el) return;
    var e = opts.etat;
    // Programme désactivé : plus de nouvelles réductions, mais celles déjà
    // gagnées par un parrain restent utilisables.
    var actif = opts.actif !== false;
    if (opts.emis) { el.innerHTML = ''; el.style.display = 'none'; return; }
    if (actif && opts.codeDemande && !(e && e.parrain)) {
      el.style.display = '';
      el.innerHTML = '<div class="pb-l"><span>Code de parrainage indiqué dans la demande : <b class="pb-code">' + esc(opts.codeDemande) +
        '</b>. Le client sera lié à son parrain à l\u2019enregistrement ; la réduction de bienvenue pourra alors être ajoutée.</span></div>';
      return;
    }
    if (!e) { el.innerHTML = ''; el.style.display = 'none'; return; }
    var lignes = opts.lignes || [];
    var dejaFilleul = lignes.some(function (l) { return l.parrainage === 'filleul'; });
    var dejaParrain = lignes.filter(function (l) { return l.parrainage === 'parrain'; })
      .reduce(function (t, l) { return t - Number(l.total || 0); }, 0);
    var morceaux = [];

    if (actif && e.parrain && !e.remiseUtilisee) {
      var minimum = Number(opts.minimum || 0);
      var assez = Number(opts.sousTotal || 0) >= minimum;
      morceaux.push(dejaFilleul
        ? '<div class="pb-l">Réduction de bienvenue appliquée <span class="pb-s">(parrainé par ' + esc(e.parrain.nom) + ')</span></div>'
        : '<div class="pb-l"><span>Parrainé par <b>' + esc(e.parrain.nom) + '</b> : réduction de bienvenue de ' + eur(opts.remiseFilleul) +
          (assez ? '.' : ', dès ' + eur(minimum) + ' de réparation.') + '</span>' +
          (assez ? '<button type="button" class="pb-b" data-pb="filleul">Ajouter la réduction</button>' : '') + '</div>');
    }
    if (!opts.devis) {
      var dispo = Math.round((e.solde - dejaParrain) * 100) / 100;
      if (dispo > 0) {
        morceaux.push('<div class="pb-l"><span>Réduction de parrainage disponible : <b>' + eur(dispo) + '</b>.</span>' +
          '<button type="button" class="pb-b" data-pb="parrain">Appliquer</button></div>');
      } else if (dejaParrain > 0) {
        morceaux.push('<div class="pb-l">Réduction de parrainage appliquée : ' + eur(dejaParrain) + '.</div>');
      }
    }
    if (actif && e.client.code_parrainage) {
      morceaux.push('<div class="pb-l pb-s">Code de parrainage de ce client : <b class="pb-code">' + esc(e.client.code_parrainage) + '</b></div>');
    }
    if (!morceaux.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = morceaux.join('');
    el.querySelectorAll('[data-pb]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.pb === 'filleul') {
          opts.ajouter('Réduction parrainage (bienvenue)', -Number(opts.remiseFilleul || 0), 'filleul');
        } else {
          var montant = Math.min(Math.round((e.solde - dejaParrain) * 100) / 100, Math.max(0, Number(opts.sousTotal || 0)));
          if (montant <= 0) return;
          opts.ajouter('Réduction parrainage', -montant, 'parrain');
        }
      });
    });
  }

  window.Parrainage = { etat: etat, rendre: rendre };
})();
