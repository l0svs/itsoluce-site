// ═══════════════════════════════════════════════════════════
//  IT Soluce — Accusé de réception du formulaire public
//  Edge Function Supabase : send-demande-confirmation
//
//  SÉCURITÉ — cette fonction est appelée par un visiteur anonyme du site
//  (pas de session Supabase), contrairement à send-invoice/send-reminder
//  qui exigent un utilisateur authentifié. Pour rester sûre malgré tout :
//   - le visiteur ne fournit QUE l'id de la demande déjà insérée en base
//     (par submit_demande_formulaire) — jamais de destinataire, sujet ou
//     contenu HTML arbitraire ;
//   - le contenu de l'e-mail est entièrement reconstruit côté serveur à
//     partir de cette ligne, avec un gabarit fixe ;
//   - un « claim » atomique (UPDATE ... WHERE email_confirmation_envoye =
//     false) garantit qu'une même demande ne peut déclencher qu'un seul
//     envoi, même en cas de rejeu ;
//   - un plafond horaire global (via enregistrer_envoi_email, déjà utilisé
//     par send-invoice/send-reminder) protège le quota Resend en cas
//     d'abus du formulaire public.
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Bucket dédié au formulaire public (pas d'utilisateur réel associé).
const BUCKET_FORMULAIRE_PUBLIC = "00000000-0000-0000-0000-000000000000";
// Très au-dessus du volume réel (1-2 réparations/mois) : sert uniquement
// à empêcher qu'un abus du formulaire ne consomme le quota Resend.
const LIMITE_HORAIRE = 30;

const ALLOWED_ORIGINS = new Set([
  "https://itsoluce.be",
  "https://www.itsoluce.be",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://itsoluce.be";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Coordonnées : la page Gestion fait foi. Elles étaient écrites en dur
//    ici, donc insensibles aux Paramètres, contrairement aux documents PDF.
type Entreprise = { nom: string; email: string; tel: string; site: string; logo: string };
const ENTREPRISE_DEFAUT: Entreprise = {
  nom: "IT Soluce",
  email: "contact@itsoluce.be",
  tel: "+32 474 05 66 59",
  site: "itsoluce.be",
  logo: "https://itsoluce.be/img/logo-full.png",
};

async function chargerEntreprise(): Promise<Entreprise> {
  const ent = { ...ENTREPRISE_DEFAUT };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?select=cle,valeur&cle=in.(entreprise_nom,entreprise_email,entreprise_telephone,entreprise_site)`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
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
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_user_id: BUCKET_FORMULAIRE_PUBLIC,
        p_destinataire: destinataire,
        p_fonction: "send-demande-confirmation",
        p_limite: LIMITE_HORAIRE,
      }),
    });
    if (!res.ok) {
      console.error("Compteur d'envois indisponible", res.status, await res.text());
      return true;
    }
    return (await res.json()) !== false;
  } catch (err) {
    console.error("Compteur d'envois indisponible", err);
    return true;
  }
}

/**
 * Signature compacte, identique à celle du rappel de rendez-vous.
 * Le logo est affiché à 78 px de large : le fichier source fait 156 px,
 * au-delà il perdrait sa netteté sur un écran retina.
 */
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

function buildEmailHtml(prenom: string, appareil: string, ent: Entreprise): string {
  // Sans prénom, on salue sans nom plutôt que d'écrire « Bonjour bonjour ».
  const salut = prenom ? `Bonjour ${escHtml(prenom)},` : "Bonjour,";
  const a = escHtml(appareil);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;line-height:1.6;">
  <p>${salut}</p>
  <p>Votre demande concernant ${a} est bien arriv&eacute;e jusqu'&agrave; moi.</p>
  <p>Je reviens vers vous d&egrave;s que possible avec un premier retour ou pour convenir d'un cr&eacute;neau.</p>
  <p>En attendant, si votre appareil est en &eacute;tat de marche, pensez &agrave; sauvegarder vos donn&eacute;es importantes.</p>
  ${signatureHtml(ent)}
</div>`;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non supportée" }, 405);

  try {
    const { demande_id } = await req.json();
    const id = Number(demande_id);
    if (!Number.isInteger(id) || id <= 0) {
      return json({ error: "demande_id invalide" }, 400);
    }

    // Claim atomique : ne renvoie la ligne que si elle n'a pas déjà été
    // traitée. Réponse volontairement identique (200, no-op) que la ligne
    // n'existe pas ou ait déjà été envoyée, pour ne pas servir d'oracle
    // permettant d'énumérer les ids existants.
    const claimRes = await fetch(
      `${SUPABASE_URL}/rest/v1/demandes_formulaire?id=eq.${id}&email_confirmation_envoye=eq.false`,
      {
        method: "PATCH",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({ email_confirmation_envoye: true }),
      },
    );

    if (!claimRes.ok) {
      console.error("Claim demandes_formulaire échoué", claimRes.status, await claimRes.text());
      return json({ ok: true }, 200);
    }

    const rows = await claimRes.json();
    const demande = Array.isArray(rows) ? rows[0] : null;
    if (!demande) {
      // Déjà envoyée, ou id inexistant : no-op silencieux.
      return json({ ok: true }, 200);
    }

    const email = String(demande.email || "").trim();
    const prenom = String(demande.prenom || "").trim();
    const appareil = String(demande.appareil || "").trim() || "votre appareil";

    if (!email) {
      console.error("Demande sans email, envoi impossible", id);
      return json({ ok: true }, 200);
    }

    if (!(await consommerQuota(email))) {
      console.error(`Limite d'envois atteinte pour send-demande-confirmation (id=${id})`);
      return json({ ok: true }, 200);
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      console.error("Configuration serveur manquante (RESEND_API_KEY)");
      return json({ ok: true }, 200);
    }

    const ent = await chargerEntreprise();

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // L'adresse d'expédition doit rester celle du domaine vérifié chez
        // Resend : la changer dans les Paramètres ferait échouer tous les
        // envois. Seul le nom affiché et l'adresse de réponse en dépendent.
        from: `${ent.nom} <${ENTREPRISE_DEFAUT.email}>`,
        reply_to: ent.email || ENTREPRISE_DEFAUT.email,
        to: [email],
        subject: `Demande bien reçue — ${ent.nom}`,
        html: buildEmailHtml(prenom, appareil, ent),
      }),
    });

    if (!resendRes.ok) {
      console.error("Resend a refusé l'envoi", resendRes.status, await resendRes.text());
      return json({ ok: true }, 200);
    }

    return json({ success: true }, 200);
  } catch (err) {
    console.error("send-demande-confirmation", err);
    // On ne renvoie jamais d'erreur exploitable au visiteur public.
    return json({ ok: true }, 200);
  }
});
