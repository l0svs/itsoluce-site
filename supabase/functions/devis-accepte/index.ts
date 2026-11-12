// ═══════════════════════════════════════════════════════════
//  IT Soluce — Mails après l'acceptation d'un devis en ligne
//  Edge Function Supabase : devis-accepte
//
//  Appelée par la page publique devis-en-ligne.html juste après que le
//  client a accepté son devis. Envoie :
//   1. au client : la confirmation avec le récapitulatif ;
//   2. à IT Soluce : la notification « devis accepté ».
//  Avec { type: "refus" } : le client a décliné le devis ; IT Soluce reçoit
//  le motif (et la demande de recontact éventuelle), le client un accusé.
//
//  SÉCURITÉ — appelée par un visiteur anonyme, comme
//  send-demande-confirmation :
//   - le visiteur ne fournit QUE le jeton secret du devis ; destinataires,
//     objet et contenu sont reconstruits ici à partir de la base ;
//   - rien n'est envoyé si le devis n'a pas réellement été accepté en
//     ligne (statut « accepte » + date d'acceptation en ligne) ;
//   - un « claim » atomique (confirmation_envoyee_le encore vide) garantit
//     un seul envoi par devis, même si l'appel est rejoué ;
//   - plafond horaire global via enregistrer_envoi_email ;
//   - réponse identique dans tous les cas : pas d'oracle sur les jetons.
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET_PUBLIC = "00000000-0000-0000-0000-000000000000";
const LIMITE_HORAIRE = 30;

const ALLOWED_ORIGINS = new Set(["https://itsoluce.be", "https://www.itsoluce.be"]);
function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://itsoluce.be";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function escHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const EUR = new Intl.NumberFormat("fr-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (v: unknown) => EUR.format(Number(v) || 0) + " €";
const dateHeure = (d: string) => {
  const x = new Date(d);
  const opts = { timeZone: "Europe/Brussels" } as const;
  return {
    date: x.toLocaleDateString("fr-BE", { ...opts, day: "numeric", month: "long", year: "numeric" }),
    heure: x.toLocaleTimeString("fr-BE", { ...opts, hour: "2-digit", minute: "2-digit" }),
  };
};

type Entreprise = { nom: string; email: string; tel: string; site: string; logo: string };
const ENTREPRISE_DEFAUT: Entreprise = {
  nom: "IT Soluce",
  email: "contact@itsoluce.be",
  tel: "+32 474 05 66 59",
  site: "itsoluce.be",
  logo: "https://itsoluce.be/img/logo-full.png",
};
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function chargerEntreprise(): Promise<Entreprise> {
  const ent = { ...ENTREPRISE_DEFAUT };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?select=cle,valeur&cle=in.(entreprise_nom,entreprise_email,entreprise_telephone,entreprise_site)`,
      { headers: svc },
    );
    if (!res.ok) return ent;
    for (const r of await res.json()) {
      const v = String(r.valeur ?? "").trim();
      if (!v) continue;
      if (r.cle === "entreprise_nom") ent.nom = v;
      if (r.cle === "entreprise_email") ent.email = v;
      if (r.cle === "entreprise_telephone") ent.tel = v;
      if (r.cle === "entreprise_site") ent.site = v.replace(/^https?:\/\//, "").replace(/\/$/, "");
    }
  } catch (err) {
    console.error("Coordonnées entreprise : valeurs par défaut conservées", err);
  }
  return ent;
}

async function consommerQuota(destinataire: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/enregistrer_envoi_email`, {
      method: "POST",
      headers: { ...svc, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user_id: BUCKET_PUBLIC, p_destinataire: destinataire, p_fonction: "devis-accepte", p_limite: LIMITE_HORAIRE }),
    });
    if (!res.ok) return true;
    return (await res.json()) !== false;
  } catch {
    return true;
  }
}

/* Signature compacte, identique au mail de confirmation du formulaire. */
function signatureHtml(ent: Entreprise): string {
  const telLien = ent.tel.replace(/[^0-9+]/g, "");
  const lien = (href: string, txt: string) =>
    `<a href="${href}" style="color:#0052CC;text-decoration:none;">${escHtml(txt)}</a>`;
  const coords = [
    ent.tel ? lien(`tel:${telLien}`, ent.tel) : "",
    ent.email ? lien(`mailto:${ent.email}`, ent.email) : "",
    ent.site ? lien(`https://${ent.site}/`, ent.site) : "",
  ].filter(Boolean).join("&nbsp;&middot;&nbsp;");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#12212e;margin:18px 0 14px;">Bien &agrave; vous,</div>` +
    `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">` +
    `<tr><td style="padding:0 0 10px;"><img src="${ent.logo}" width="78" height="32" alt="${escHtml(ent.nom)}" style="display:block;border:0;"></td></tr>` +
    `<tr><td style="border-top:2px solid #0052CC;padding:9px 0 0;font-size:13px;font-weight:bold;color:#12212e;">R&eacute;parations informatiques &amp; &eacute;lectroniques</td></tr>` +
    `<tr><td style="padding:4px 0 0;font-size:13px;line-height:1.7;color:#5a6b7b;">${coords}</td></tr>` +
    `</table>`;
}

// deno-lint-ignore no-explicit-any
function recapHtml(d: any): string {
  const td = "padding:7px 0;border-bottom:1px solid #e3e8ee;font-size:14px;";
  // deno-lint-ignore no-explicit-any
  const lignes = (Array.isArray(d.lignes) ? d.lignes : []).map((l: any) => {
    const q = Number(l.quantite) || 1;
    const total = l.total ?? q * (Number(l.prix_unitaire) || 0);
    return `<tr><td style="${td}">${escHtml(l.description)}${q > 1 ? ` <span style="color:#5a6b7b;">(${q} × ${eur(l.prix_unitaire)})</span>` : ""}</td>` +
      `<td style="${td}text-align:right;white-space:nowrap;padding-left:14px;">${eur(total)}</td></tr>`;
  }).join("");
  const remise = Number(d.remise) || 0;
  const acompte = Number(d.acompte) || 0;
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;width:100%;max-width:520px;font-family:Arial,Helvetica,sans-serif;color:#12212e;margin:4px 0 14px;">` +
    lignes +
    (remise > 0 ? `<tr><td style="padding:7px 0;font-size:14px;color:#5a6b7b;">Remise</td><td style="padding:7px 0;text-align:right;font-size:14px;color:#5a6b7b;">− ${eur(remise)}</td></tr>` : "") +
    `<tr><td style="padding:10px 0 4px;font-size:15px;font-weight:bold;">Total</td><td style="padding:10px 0 4px;text-align:right;font-size:15px;font-weight:bold;">${eur(d.total)}</td></tr>` +
    (acompte > 0 ? `<tr><td style="padding:4px 0;font-size:14px;color:#5a6b7b;">Acompte demandé à l'acceptation</td><td style="padding:4px 0;text-align:right;font-size:14px;color:#5a6b7b;">${eur(acompte)}</td></tr>` : "") +
    `</table>`;
}

const P = (html: string) => `<p style="margin:0 0 12px;">${html}</p>`;
const enveloppe = (corps: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#12212e;line-height:1.6;">${corps}</div>`;

// deno-lint-ignore no-explicit-any
function mailClient(d: any, ent: Entreprise): string {
  const prenom = String(d.client_nom || "").trim().split(/\s+/)[0] || "";
  const { date, heure } = dateHeure(d.accepte_en_ligne_le);
  const lienDevis = `https://itsoluce.be/devis-en-ligne.html?t=${d.jeton_public}`;
  const acompte = Number(d.acompte) || 0;
  return enveloppe(
    P(prenom ? `Bonjour ${escHtml(prenom)},` : "Bonjour,") +
    P(`Je vous confirme la bonne réception de votre acceptation du devis <b>${escHtml(d.numero)}</b>.<br>` +
      `Accepté en ligne le ${escHtml(date)} à ${escHtml(heure)}${d.accepte_par_nom ? ` par ${escHtml(d.accepte_par_nom)}` : ""}.`) +
    P("<b>Récapitulatif</b>") +
    recapHtml(d) +
    (acompte > 0 ? P(`Un acompte de ${eur(acompte)} est demandé avant le début de la réparation.`) : "") +
    P("Je vous recontacte rapidement pour organiser la réparation.") +
    P(`Votre devis reste consultable à tout moment : <a href="${lienDevis}" style="color:#0052CC;">voir le devis ${escHtml(d.numero)}</a>.<br>` +
      `<a href="https://itsoluce.be/#conditions" style="color:#0052CC;">Conditions générales de service</a>`) +
    signatureHtml(ent),
  );
}

// deno-lint-ignore no-explicit-any
function mailNotification(d: any): string {
  const { date, heure } = dateHeure(d.accepte_en_ligne_le);
  const lienErp = `https://itsoluce.be/admin/devis.html?q=${encodeURIComponent(d.numero)}`;
  return enveloppe(
    P(`<b>Le devis ${escHtml(d.numero)} vient d'être accepté en ligne.</b>`) +
    P(`Client : ${escHtml(d.client_societe || d.client_nom)}${d.client_telephone ? ` · ${escHtml(d.client_telephone)}` : ""}${d.client_email ? ` · ${escHtml(d.client_email)}` : ""}<br>` +
      `Accepté le ${escHtml(date)} à ${escHtml(heure)}${d.accepte_par_nom ? ` par ${escHtml(d.accepte_par_nom)}` : ""}.`) +
    recapHtml(d) +
    (d.reparation_numero
      ? P(`Le dossier de réparation <b>${escHtml(d.reparation_numero)}</b> est prêt dans l'ERP (à réceptionner).<br>` +
          `<a href="https://itsoluce.be/admin/reparations.html?q=${encodeURIComponent(d.reparation_numero)}" style="color:#0052CC;font-weight:bold;">Ouvrir le dossier ${escHtml(d.reparation_numero)}</a>` +
          ` · <a href="${lienErp}" style="color:#0052CC;">Voir le devis</a>`)
      : P(`Prochaine étape : créer la réparation.<br><a href="${lienErp}" style="color:#0052CC;font-weight:bold;">Ouvrir le devis dans l'ERP</a>`)) +
    P(d.client_email ? "Le client a reçu un mail de confirmation." : "Pas d'adresse e-mail : le client n'a pas reçu de confirmation."),
  );
}

const MOTIFS: Record<string, string> = {
  prix: "Le prix est trop élevé",
  autre_solution: "A trouvé une autre solution",
  plus_besoin: "Ne fait finalement plus réparer",
  delai: "Le délai est trop long",
  autre: "Autre raison",
};

// deno-lint-ignore no-explicit-any
function mailRefusClient(d: any, ent: Entreprise): string {
  const prenom = String(d.client_nom || "").trim().split(/\s+/)[0] || "";
  return enveloppe(
    P(prenom ? `Bonjour ${escHtml(prenom)},` : "Bonjour,") +
    P(`J'ai bien reçu votre réponse concernant le devis <b>${escHtml(d.numero)}</b>.<br>Merci d'avoir pris le temps de répondre.`) +
    P(d.recontact_souhaite
      ? "Je vous recontacte rapidement avec une solution moins chère."
      : "Si vous changez d'avis ou si votre besoin évolue, n'hésitez pas à me contacter.") +
    signatureHtml(ent),
  );
}

// deno-lint-ignore no-explicit-any
function mailRefusNotification(d: any): string {
  const { date, heure } = dateHeure(d.refuse_en_ligne_le);
  const lienErp = `https://itsoluce.be/admin/devis.html?q=${encodeURIComponent(d.numero)}`;
  return enveloppe(
    P(`<b>Le devis ${escHtml(d.numero)} a été refusé en ligne.</b>`) +
    (d.recontact_souhaite
      ? `<p style="margin:0 0 12px;padding:10px 14px;background:#fff6e8;border-left:3px solid #b25e09;color:#7a4206;"><b>Le client souhaite être recontacté pour une solution moins chère.</b></p>`
      : "") +
    P(`Client : ${escHtml(d.client_societe || d.client_nom)}${d.client_telephone ? ` · ${escHtml(d.client_telephone)}` : ""}${d.client_email ? ` · ${escHtml(d.client_email)}` : ""}<br>` +
      `Refusé le ${escHtml(date)} à ${escHtml(heure)}.<br>` +
      `Motif : <b>${escHtml(MOTIFS[d.motif_refus] || d.motif_refus || "non précisé")}</b>`) +
    (d.commentaire_refus ? P(`Commentaire du client :<br><i>${escHtml(d.commentaire_refus).replace(/\n/g, "<br>")}</i>`) : "") +
    recapHtml(d) +
    P(`<a href="${lienErp}" style="color:#0052CC;font-weight:bold;">Ouvrir le devis dans l'ERP</a>`),
  );
}

async function envoyer(cle: string, ent: Entreprise, to: string, subject: string, html: string): Promise<boolean> {
  if (!(await consommerQuota(to))) {
    console.error("Limite d'envois atteinte (devis-accepte)");
    return false;
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cle}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      // Adresse d'expédition : domaine vérifié chez Resend (voir send-demande-confirmation).
      from: `${ent.nom} <${ENTREPRISE_DEFAUT.email}>`,
      reply_to: ent.email || ENTREPRISE_DEFAUT.email,
      to: [to],
      subject,
      html,
    }),
  });
  if (!r.ok) console.error("Resend a refusé l'envoi", r.status, await r.text());
  return r.ok;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non supportée" }, 405);

  try {
    const { jeton, type } = await req.json();
    const refus = type === "refus";
    if (typeof jeton !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jeton)) {
      return json({ ok: true });
    }

    // Claim atomique : seulement un devis réellement accepté en ligne,
    // dont les mails ne sont pas encore partis.
    const filtre = refus
      ? `statut=eq.refuse&refuse_en_ligne_le=not.is.null&refus_notifie_le=is.null`
      : `statut=eq.accepte&accepte_en_ligne_le=not.is.null&confirmation_envoyee_le=is.null`;
    const claim = await fetch(
      `${SUPABASE_URL}/rest/v1/devis?jeton_public=eq.${jeton}&${filtre}&supprime_le=is.null` +
        `&select=numero,client_nom,client_societe,client_email,client_telephone,lignes,total,remise,acompte,accepte_en_ligne_le,accepte_par_nom,reparation_numero,jeton_public,refuse_en_ligne_le,motif_refus,commentaire_refus,recontact_souhaite`,
      {
        method: "PATCH",
        headers: { ...svc, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify(refus ? { refus_notifie_le: new Date().toISOString() } : { confirmation_envoyee_le: new Date().toISOString() }),
      },
    );
    if (!claim.ok) {
      console.error("Claim devis échoué", claim.status, await claim.text());
      return json({ ok: true });
    }
    const rows = await claim.json();
    const d = Array.isArray(rows) ? rows[0] : null;
    if (!d) return json({ ok: true });

    const cle = Deno.env.get("RESEND_API_KEY");
    if (!cle) {
      console.error("Configuration serveur manquante (RESEND_API_KEY)");
      return json({ ok: true });
    }
    const ent = await chargerEntreprise();
    const client = String(d.client_email || "").trim();
    if (refus) {
      if (client) await envoyer(cle, ent, client, `Votre réponse au devis ${d.numero}`, mailRefusClient(d, ent));
      await envoyer(cle, ent, ent.email || ENTREPRISE_DEFAUT.email,
        `Devis ${d.numero} refusé${d.recontact_souhaite ? " — à recontacter" : ""} — ${d.client_societe || d.client_nom || "client"}`,
        mailRefusNotification(d));
      return json({ ok: true });
    }
    if (client) {
      await envoyer(cle, ent, client, `Confirmation — devis ${d.numero} accepté`, mailClient(d, ent));
    }
    await envoyer(cle, ent, ent.email || ENTREPRISE_DEFAUT.email,
      `Devis ${d.numero} accepté en ligne — ${d.client_societe || d.client_nom || "client"}`, mailNotification(d));
    return json({ ok: true });
  } catch (err) {
    console.error("devis-accepte", err);
    return json({ ok: true });
  }
});
