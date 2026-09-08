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
//   - un "claim" atomique (UPDATE ... WHERE email_confirmation_envoye =
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

function buildEmailHtml(prenom: string, appareil: string): string {
  const p = escHtml(prenom);
  const a = escHtml(appareil);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;line-height:1.6;">
  <p>Bonjour ${p},</p>
  <p>Votre demande pour ${a} est bien arrivée jusqu'à moi.</p>
  <p>Je reviens vers vous sous 1 à 2h avec un premier retour ou pour convenir d'un créneau.</p>
  <p>En attendant, si votre appareil est en état de marche, pensez à sauvegarder vos données importantes.</p>

  <table style="margin-top:24px;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">
    <tr><td colspan="2" style="border-top:3px solid #1a4fd6;padding-bottom:12px;"></td></tr>
    <tr>
      <td style="vertical-align:top;padding-right:16px;">
        <span style="font-weight:800;font-size:28px;line-height:1;color:#1a4fd6;letter-spacing:-1px;">IT</span>
      </td>
      <td style="border-left:2px solid #d8d8e0;padding-left:16px;">
        <div style="font-weight:700;font-size:17px;color:#111;">IT Soluce</div>
        <div style="font-size:14px;color:#111;margin-bottom:10px;">Réparations informatiques &amp; électroniques</div>
        <div style="font-size:13px;color:#111;margin-bottom:4px;"><b>E</b> <a href="mailto:contact@itsoluce.be" style="color:#111;text-decoration:underline;">contact@itsoluce.be</a></div>
        <div style="font-size:13px;color:#111;margin-bottom:4px;"><b>T</b> <a href="tel:+32474056659" style="color:#111;text-decoration:underline;">+32 474 05 66 59</a></div>
        <div style="font-size:13px;color:#111;"><b>W</b> <a href="https://itsoluce.be" style="color:#3b82f6;text-decoration:none;">itsoluce.be</a></div>
      </td>
    </tr>
  </table>
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
    const prenom = String(demande.prenom || "").trim() || "bonjour";
    const appareil = String(demande.appareil || "votre appareil").trim();

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

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "IT Soluce <contact@itsoluce.be>",
        to: [email],
        subject: "Demande bien reçue — IT Soluce",
        html: buildEmailHtml(prenom, appareil),
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
