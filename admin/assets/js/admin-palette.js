/**
 * Palette de commandes de l'ERP IT Soluce (Cmd+K / Ctrl+K).
 *
 * Recherche unifiée : les 15 pages de l'ERP (correspondance sur le libellé,
 * source commune avec admin-nav.js via window.ADMIN_PAGES) + les clients,
 * réparations, devis et factures (recherche live dans Supabase dès 2
 * caractères). Objectif : ne plus avoir à ouvrir Clients pour chercher un
 * nom, puis Factures pour chercher un numéro — un seul raccourci, partout.
 *
 * Chargé sur chaque page juste après admin-nav.js. Ne dépend d'aucun état de
 * page (pas besoin d'être connecté à la session Supabase de la page — le
 * client Supabase est créé ici avec la même clé publique anon déjà présente
 * dans le code source de toutes les pages).
 */
(function () {
  'use strict';

  var SB_URL = 'https://esltsiutcjcwdbhkkvms.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVzbHRzaXV0Y2pjd2RiaGtrdm1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3NjM2OTEsImV4cCI6MjA5NzMzOTY5MX0.Sl2cdnqEr7VSBeq1wwMBpfQW9yBB0IG9RkOiZi9GXvo';

  var TYPE_META = {
    page: { badge: '#', color: 'var(--t3)', bg: 'var(--bg3)', section: 'Pages' },
    client: { badge: 'C', color: '#3b82f6', bg: 'rgba(59,130,246,.15)', section: 'Clients' },
    reparation: { badge: 'R', color: '#fb923c', bg: 'rgba(251,146,60,.15)', section: 'Réparations' },
    devis: { badge: 'D', color: '#a78bfa', bg: 'rgba(167,139,250,.15)', section: 'Devis' },
    facture: { badge: 'F', color: '#34d399', bg: 'rgba(52,211,153,.15)', section: 'Factures' }
  };

  function escHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- Styles (utilise les variables déjà définies globalement par chaque page, donc respecte le thème clair/sombre) ----
  var style = document.createElement('style');
  style.textContent =
    '#cp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:900;opacity:0;pointer-events:none;transition:opacity .15s;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;}' +
    '#cp-overlay.open{opacity:1;pointer-events:all;}' +
    '#cp-box{width:92%;max-width:560px;background:var(--bg2);border:1px solid var(--ln2);border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.4);overflow:hidden;transform:translateY(-8px);transition:transform .15s;}' +
    '#cp-overlay.open #cp-box{transform:translateY(0);}' +
    '#cp-input{width:100%;padding:16px 18px;background:none;border:none;border-bottom:1px solid var(--ln);color:var(--t1);font-size:15px;font-family:inherit;outline:none;}' +
    '#cp-input::placeholder{color:var(--t3);}' +
    '#cp-list{max-height:50vh;overflow-y:auto;padding:6px;}' +
    '.cp-sec{font-size:10px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.6px;padding:10px 10px 4px;}' +
    '.cp-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer;color:var(--t1);}' +
    '.cp-item.sel,.cp-item:hover{background:var(--bg3);}' +
    '.cp-item-ic{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:11px;font-weight:700;}' +
    '.cp-item-main{flex:1;min-width:0;}' +
    '.cp-item-t{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.cp-item-s{font-size:11px;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.cp-empty,.cp-hint{padding:26px 16px;text-align:center;color:var(--t3);font-size:12px;}' +
    // bottom:64px (pas 20px) pour ne pas se superposer aux toasts de succès/erreur
    // (.toast, présents sur chaque page à bottom:20px;right:20px).
    '#cp-trigger{position:fixed;right:18px;bottom:64px;z-index:850;display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--bg2);border:1px solid var(--ln2);border-radius:99px;color:var(--t2);font-size:11px;font-family:inherit;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);}' +
    '#cp-trigger:hover{color:var(--t1);border-color:var(--a);}' +
    '#cp-trigger kbd{font:inherit;font-size:10px;padding:1px 5px;border-radius:4px;background:var(--bg3);border:1px solid var(--ln2);}' +
    '@media(max-width:900px){#cp-trigger{display:none;}}';
  document.head.appendChild(style);

  // ---- Déclencheur flottant (indépendant du contenu de la topbar, qui varie légèrement d'une page à l'autre) ----
  var isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  var trigger = document.createElement('button');
  trigger.id = 'cp-trigger';
  trigger.type = 'button';
  trigger.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Rechercher<kbd>' + (isMac ? '⌘K' : 'Ctrl K') + '</kbd>';
  document.body.appendChild(trigger);

  var overlay = document.createElement('div');
  overlay.id = 'cp-overlay';
  overlay.innerHTML = '<div id="cp-box"><input id="cp-input" placeholder="Rechercher une page, un client, un numéro..." autocomplete="off" spellcheck="false"/><div id="cp-list"></div></div>';
  document.body.appendChild(overlay);

  var input = overlay.querySelector('#cp-input');
  var list = overlay.querySelector('#cp-list');
  var results = [];
  var selIndex = 0;
  var debounceTimer = null;
  var searchToken = 0;

  var STATIC_PAGES = (window.ADMIN_PAGES || []).map(function (p) {
    return { type: 'page', title: p.label, sub: '', href: p.href };
  });

  function itemHtml(r, i) {
    var m = TYPE_META[r.type];
    return '<div class="cp-item' + (i === selIndex ? ' sel' : '') + '" data-i="' + i + '">' +
      '<div class="cp-item-ic" style="color:' + m.color + ';background:' + m.bg + ';">' + m.badge + '</div>' +
      '<div class="cp-item-main"><div class="cp-item-t">' + escHtml(r.title) + '</div>' +
      (r.sub ? '<div class="cp-item-s">' + escHtml(r.sub) + '</div>' : '') + '</div></div>';
  }

  function render() {
    if (!results.length) {
      list.innerHTML = input.value.trim().length >= 2
        ? '<div class="cp-empty">Aucun résultat</div>'
        : (input.value.trim() ? '' : '<div class="cp-hint">Tapez pour chercher une page, un client, un numéro de devis/facture/réparation…</div>');
      return;
    }
    var lastSection = null;
    var html = '';
    results.forEach(function (r, i) {
      var section = TYPE_META[r.type].section;
      if (section !== lastSection) { html += '<div class="cp-sec">' + section + '</div>'; lastSection = section; }
      html += itemHtml(r, i);
    });
    list.innerHTML = html;
  }

  function go(r) {
    if (!r) return;
    window.location.href = r.href;
  }

  list.addEventListener('click', function (e) {
    var item = e.target.closest('.cp-item');
    if (item) go(results[Number(item.dataset.i)]);
  });

  var sbPromise = null;
  function getSb() {
    if (!sbPromise) {
      sbPromise = import('https://esm.sh/@supabase/supabase-js@2')
        .then(function (mod) { return mod.createClient(SB_URL, SB_KEY); })
        .catch(function (e) { console.warn('Palette : Supabase indisponible', e); return null; });
    }
    return sbPromise;
  }

  function staticMatches(q) {
    var needle = q.toLowerCase();
    return STATIC_PAGES.filter(function (p) { return p.title.toLowerCase().indexOf(needle) >= 0; });
  }

  function runSearch(raw) {
    clearTimeout(debounceTimer);
    var q = raw.trim();
    if (!q) { results = []; selIndex = 0; render(); return; }
    if (q.length < 2) { results = staticMatches(q); selIndex = 0; render(); return; }

    var myToken = ++searchToken;
    debounceTimer = setTimeout(function () {
      getSb().then(function (sb) {
        var pages = staticMatches(q);
        if (!sb) { if (myToken === searchToken) { results = pages; selIndex = 0; render(); } return; }
        // Nettoyage minimal : ces caractères casseraient la syntaxe du filtre .or() de PostgREST.
        var safe = q.replace(/[,()%]/g, ' ').trim();
        if (!safe) { if (myToken === searchToken) { results = pages; selIndex = 0; render(); } return; }
        var like = '%' + safe + '%';
        Promise.all([
          sb.from('clients').select('id,numero,nom,email').or('nom.ilike.' + like + ',numero.ilike.' + like + ',email.ilike.' + like).limit(5),
          sb.from('reparations').select('id,numero,client_nom,appareil').or('numero.ilike.' + like + ',client_nom.ilike.' + like + ',appareil.ilike.' + like).limit(5),
          sb.from('devis').select('id,numero,client_nom,total').or('numero.ilike.' + like + ',client_nom.ilike.' + like).limit(5),
          sb.from('factures').select('id,numero,client_nom,total').or('numero.ilike.' + like + ',client_nom.ilike.' + like).limit(5)
        ]).then(function (res) {
          if (myToken !== searchToken) return; // une frappe plus récente a déjà relancé une recherche
          var entities = [];
          (res[0].data || []).forEach(function (c) {
            entities.push({ type: 'client', title: c.nom || '—', sub: [c.numero, c.email].filter(Boolean).join(' · '), href: '/admin/clients.html?q=' + encodeURIComponent(c.numero || c.nom || '') });
          });
          (res[1].data || []).forEach(function (r) {
            entities.push({ type: 'reparation', title: (r.numero ? r.numero + ' · ' : '') + (r.client_nom || '—'), sub: r.appareil || '', href: '/admin/reparations.html?q=' + encodeURIComponent(r.numero || r.client_nom || '') });
          });
          (res[2].data || []).forEach(function (d) {
            entities.push({ type: 'devis', title: (d.numero ? d.numero + ' · ' : '') + (d.client_nom || '—'), sub: d.total != null ? Number(d.total).toFixed(2) + ' €' : '', href: '/admin/devis.html?q=' + encodeURIComponent(d.numero || d.client_nom || '') });
          });
          (res[3].data || []).forEach(function (f) {
            entities.push({ type: 'facture', title: (f.numero ? f.numero + ' · ' : '') + (f.client_nom || '—'), sub: f.total != null ? Number(f.total).toFixed(2) + ' €' : '', href: '/admin/factures.html?open=' + f.id });
          });
          results = pages.concat(entities);
          selIndex = 0;
          render();
        }).catch(function (e) {
          console.warn('Palette : recherche échouée', e);
          if (myToken === searchToken) { results = pages; selIndex = 0; render(); }
        });
      });
    }, 220);
  }

  function scrollSelIntoView() {
    var el = list.querySelector('.cp-item.sel');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', function () { runSearch(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (results.length) { selIndex = Math.min(selIndex + 1, results.length - 1); render(); scrollSelIntoView(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (results.length) { selIndex = Math.max(selIndex - 1, 0); render(); scrollSelIntoView(); } }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[selIndex]); }
  });

  function openPalette() {
    overlay.classList.add('open');
    input.value = '';
    results = STATIC_PAGES.slice(0, 8);
    selIndex = 0;
    render();
    setTimeout(function () { input.focus(); }, 10);
  }
  function closePalette() {
    overlay.classList.remove('open');
  }

  trigger.addEventListener('click', openPalette);
  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closePalette(); });
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      overlay.classList.contains('open') ? closePalette() : openPalette();
    } else if (e.key === 'Escape' && overlay.classList.contains('open')) {
      closePalette();
    }
  });

  window.openCommandPalette = openPalette;
})();
