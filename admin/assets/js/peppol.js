/* ═══════════════════════════════════════════════════════════
   IT Soluce — envoi des factures via Peppol (point d'accès Recommand)

   Tout passe par la fonction serveur « peppol » : la clé Recommand reste
   côté serveur, jamais dans le navigateur.
     verifier  { tva }         → { inscrit, participant }
     envoyer   { facture_id }  → { facture }  (colonnes peppol_* à jour)
     statut    { facture_id }  → { facture }

   Règles :
   - client professionnel belge (n° de TVA renseigné) uniquement ;
   - la facture part APRÈS l'encaissement (note de crédit : une fois réglée) ;
   - elle ne part qu'une seule fois : le serveur la réserve avant l'envoi,
     et un envoi au résultat incertain se vérifie, il ne se renvoie pas.
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  let cfg = null;
  const enCours = new Map();   // n° BCE → promesse de vérification
  const connus = new Map();    // n° BCE → résultat déjà obtenu

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const quand = (iso) => {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    return d.toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' à ' +
      d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });
  };

  async function appel(corps) {
    if (!cfg) throw new Error('Peppol non configuré');
    const jeton = await cfg.jeton();
    let r;
    try {
      r = await fetch(cfg.SB + '/functions/v1/peppol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jeton },
        body: JSON.stringify(corps),
      });
    } catch (e) { throw new Error('connexion impossible, vérifie ta connexion internet'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('erreur ' + r.status));
    return j;
  }

  /** « BE 0123.456.789 », « 0123456789 » → « 0123456789 » si le n° belge est valide (modulo 97), sinon ''. */
  function numero(tva) {
    let n = String(tva || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (n.startsWith('BE')) n = n.slice(2);
    if (/^\d{9}$/.test(n)) n = '0' + n;
    if (!/^[01]\d{9}$/.test(n)) return '';
    return 97 - (Number(n.slice(0, 8)) % 97) === Number(n.slice(8)) ? n : '';
  }
  const belge = (tva) => /^BE/i.test(String(tva || '').replace(/[^0-9A-Z]/gi, '')) || /^[01]?\d{9}$/.test(String(tva || '').replace(/\D/g, ''));

  function verifier(tva) {
    const n = numero(tva);
    if (!n) return Promise.resolve({ inscrit: false, invalide: true });
    if (connus.has(n)) return Promise.resolve(connus.get(n));
    if (!enCours.has(n)) {
      enCours.set(n, appel({ action: 'verifier', tva: n })
        .then((r) => { const v = { inscrit: !!r.inscrit, participant: r.participant || null }; connus.set(n, v); return v; })
        .finally(() => enCours.delete(n)));
    }
    return enCours.get(n);
  }
  /** Résultat déjà connu (sans appel), pour l'étape suivante. */
  const connu = (tva) => connus.get(numero(tva)) || null;

  /** La facture peut-elle partir maintenant ? (encaissée ; note de crédit réglée) */
  function prete(f, estNC) {
    if (!f || !f.numero) return false;
    return estNC ? ['imputee', 'remboursee'].includes(f.statut) : f.statut === 'payee';
  }
  /** Bouton « Envoyer via Peppol » à proposer dans l'étape suivante ? */
  function aEnvoyer(f, estNC) {
    // Déjà envoyée par mail : pas de proposition automatique (doublon chez le client).
    if (!f || !numero(f.client_tva) || f.peppol_statut || f.email_envoye || !prete(f, estNC)) return false;
    const v = connu(f.client_tva);
    return !!(v && v.inscrit);
  }

  /* ── Bloc sous l'aperçu de la facture ── */
  async function bloc(el, f, o) {
    if (!el) return;
    const tva = f && f.client_tva;
    if (!f || !f.id || !tva || !belge(tva) || ['annulee', 'creditee'].includes(f.statut) && !f.peppol_statut) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const id = f.id, nc = o.estNC(f);
    const doc = nc ? 'la note de crédit' : 'la facture', Doc = nc ? 'Note de crédit' : 'Facture';
    const client = esc(f.client_societe || f.client_nom || 'le client');
    const rendre = (etat, titre, texte, bouton) => {
      if (!o.courante() || o.courante().id !== id) return;   // une autre facture a été ouverte entre-temps
      el.className = 'peppol pp-' + etat;
      el.innerHTML = `<div class="pp-tete"><span class="pp-nom">Peppol</span><span class="pp-etat">${esc(titre)}</span></div>` +
        (texte ? `<p class="pp-txt">${texte}</p>` : '') +
        (bouton ? `<div class="prev-acts">${bouton}</div>` : '');
    };
    const id_ = f.peppol_destinataire ? `<br><span class="pp-id">${esc(f.peppol_destinataire)}</span>` : '';

    switch (f.peppol_statut) {
      case 'livree':
        return rendre('ok', 'Transmise', `${Doc} transmise à ${client} le ${esc(quand(f.peppol_livree_le || f.peppol_envoye_le))}.` +
          (f.peppol_mail_le ? `<br>Le client en a été informé par mail.` : (f.client_email ? `<br>Le mail d'information au client part dans quelques minutes.` : `<br>Pas d'adresse e-mail : le client n'est pas prévenu par mail.`)) + id_);
      case 'en_cours':
        return rendre('attente', 'Livraison en cours', `Envoyée le ${esc(quand(f.peppol_envoye_le))}.<br>La confirmation de livraison arrive en général en quelques minutes ; elle se met à jour toute seule.${f.client_email ? '<br>Le client sera prévenu par mail dès la livraison.' : ''}${id_}`,
          `<button class="btn btn-secondary" data-pp="actualiser">Actualiser</button>`);
      case 'envoi':
        return rendre('attente', 'Envoi en cours', 'Envoi en cours de traitement, ne relance pas.',
          `<button class="btn btn-secondary" data-pp="actualiser">Actualiser</button>`);
      case 'incertain':
        return rendre('attente', 'À vérifier', `${esc(f.peppol_erreur || 'Résultat de l\'envoi inconnu.')}<br>Aucun renvoi tant que la vérification n'est pas faite.`,
          `<button class="btn btn-secondary" data-pp="actualiser">Vérifier chez Recommand</button>`);
      case 'echec':
        return rendre('erreur', 'Non envoyée', `${esc(f.peppol_erreur || 'Erreur inconnue.')}<br>Rien n'est parti chez le client.`,
          prete(f, nc) ? `<button class="btn btn-primary" data-pp="envoyer">Réessayer l'envoi Peppol</button>` : '');
    }

    if (!numero(tva)) return rendre('neutre', 'N° de TVA à vérifier', 'Le numéro de TVA du client n\'est pas un numéro belge valide : Peppol impossible, envoi par mail uniquement.');
    rendre('attente', 'Vérification…', '', '');
    let v;
    try { v = await verifier(tva); } catch (e) {
      return rendre('erreur', 'Vérification impossible', esc(e.message || e), `<button class="btn btn-secondary" data-pp="verifier">Réessayer</button>`);
    }
    if (o.majEtape) o.majEtape();
    if (!v.inscrit) return rendre('neutre', 'Client pas sur Peppol', `${client} n'est pas (encore) inscrit sur Peppol : envoie ${doc} par mail.`);
    if (!prete(f, nc)) {
      return rendre('pret', 'Client inscrit', `${client} reçoit ses factures via Peppol.<br>${nc ? 'La note de crédit' : 'La facture'} pourra partir via Peppol une fois ${nc ? 'réglée' : 'encaissée'}.`);
    }
    if (f.email_envoye) {
      const le = f.date_envoi ? ' le ' + esc(quand(f.date_envoi)).replace(/ à .*$/, '') : '';
      return rendre('neutre', 'Déjà envoyée par mail', `${nc ? 'La note de crédit' : 'La facture'} a déjà été envoyée par mail${le}.<br>Pour éviter un doublon chez ${client}, elle ne part pas via Peppol.`,
        `<button class="btn btn-secondary" data-pp="envoyer">Envoyer quand même via Peppol</button>`);
    }
    rendre('pret', 'Prête à partir', `${client} reçoit ses factures via Peppol.<br><span class="pp-id">${esc(v.participant || '')}</span>`,
      `<button class="btn btn-primary" data-pp="envoyer">Envoyer via Peppol</button>`);
  }

  /** Clics du bloc (délégation : le bloc est réécrit à chaque changement). */
  function brancher(el, o) {
    if (!el || el.dataset.ppBranche) return;
    el.dataset.ppBranche = '1';
    el.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-pp]');
      if (!b || b.disabled) return;
      const a = b.dataset.pp;
      if (a === 'verifier') { connus.delete(numero((o.courante() || {}).client_tva)); return o.rafraichir(); }
      const lib = b.innerHTML;
      b.disabled = true;
      try {
        if (a === 'envoyer') await envoyerCourante(o, b);
        else if (a === 'actualiser') {
          b.textContent = 'Vérification…';
          const r = await appel({ action: 'statut', facture_id: o.courante().id });
          o.apres(r.facture);
        }
      } catch (e) {
        o.toast('Peppol : ' + (e.message || e), 'err');
      } finally { if (b.isConnected) { b.disabled = false; b.innerHTML = lib; } }
    });
  }

  let _envoiEnCours = false;
  /** Envoie la facture ouverte (une fois encaissée). Le serveur garantit l'envoi unique. */
  async function envoyerCourante(o, b) {
    if (_envoiEnCours) return;
    const f = o.courante();
    if (!f) return;
    const nc = o.estNC(f);
    if (!prete(f, nc)) { o.toast(nc ? 'La note de crédit part via Peppol une fois réglée.' : 'La facture part via Peppol une fois encaissée.', 'err'); return; }
    const dejaMail = f.email_envoye ? `\n\nAttention : elle a déjà été envoyée par mail. Le client la recevra une deuxième fois.` : '';
    if (!confirm(`Envoyer ${nc ? 'la note de crédit' : 'la facture'} ${f.numero} à ${f.client_societe || f.client_nom} via Peppol ?\n\nElle ne part qu'une seule fois.${dejaMail}`)) return;
    _envoiEnCours = true;
    document.querySelectorAll('[data-pp="envoyer"],.pp-envoyer').forEach((x) => { x.disabled = true; });
    try {
      if (b && b.isConnected) b.textContent = 'Envoi…';
      const r = await appel({ action: 'envoyer', facture_id: f.id });
      o.apres(r.facture);
      const st = r.facture && r.facture.peppol_statut;
      const Doc = nc ? 'Note de crédit' : 'Facture';
      if (st === 'livree') o.toast(`${Doc} ${f.numero} transmise via Peppol`, 'ok');
      else if (st === 'en_cours') o.toast(`${Doc} ${f.numero} envoyée via Peppol, livraison en cours`, 'ok');
      else if (st === 'echec') o.toast('Peppol : envoi refusé, voir le détail sous l\'aperçu', 'err');
      else o.toast('Peppol : résultat à vérifier, voir le détail sous l\'aperçu', 'err');
    } finally {
      _envoiEnCours = false;
      document.querySelectorAll('[data-pp="envoyer"],.pp-envoyer').forEach((x) => { x.disabled = false; });
    }
  }

  window.Peppol = {
    config: (c) => { cfg = c; },
    numero, verifier, connu, prete, aEnvoyer, bloc, brancher, envoyerCourante,
  };
})();
