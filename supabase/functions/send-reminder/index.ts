// ═══════════════════════════════════════════════════════════
//  IT Soluce — Rappel de rendez-vous par e-mail
//  Edge Function Supabase : send-reminder
//
//  SÉCURITÉ — voir le commentaire détaillé dans send-invoice/index.ts.
//  En résumé : « verify_jwt » accepte la clé anon, qui est publique.
//  On exige donc ici un jeton appartenant à un vrai utilisateur connecté,
//  sinon la fonction est un relais d'e-mail ouvert sous notre domaine.
// ════════════════════════════════════════════════════════

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Plafond d'envois par utilisateur et par heure. Très au-dessus d'un usage
// normal, mais suffisant pour qu'une session volée ne serve pas de canon à spam.
const LIMITE_HORAIRE = 60;

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

async function getAuthenticatedUser(req: Request): Promise<{ id: string; email?: string } | null> {
  const raw = req.headers.get("Authorization") ?? "";
  const jwt = raw.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && typeof user.id === "string" ? user : null;
  } catch {
    return null;
  }
}

/**
 * Consomme un jeton du quota horaire et journalise l'envoi dans email_envois.
 * Renvoie false si le quota est atteint.
 *
 * En cas d'indisponibilité de la base on laisse passer : la protection
 * principale reste l'authentification ci-dessus, et bloquer un rappel client
 * coûte plus cher qu'un compteur momentanément imprécis.
 */
async function consommerQuota(userId: string, destinataire: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/enregistrer_envoi_email`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_destinataire: destinataire,
        p_fonction: "send-reminder",
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

const MAX_SUBJECT = 300;
const MAX_HTML = 200_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non supportée" }, 405);

  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ error: "Authentification requise." }, 401);
  }

  try {
    const { to, subject, html } = await req.json();

    if (!to || !subject || !html) {
      return json({ error: "Champs manquants (to, subject, html requis)" }, 400);
    }
    if (typeof to !== "string" || !EMAIL_RE.test(to.trim())) {
      return json({ error: "Adresse destinataire invalide." }, 400);
    }
    if (typeof subject !== "string" || subject.length > MAX_SUBJECT) {
      return json({ error: "Sujet trop long." }, 400);
    }
    if (typeof html !== "string" || html.length > MAX_HTML) {
      return json({ error: "Contenu du message trop volumineux." }, 400);
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      return json({ error: "Configuration serveur manquante (RESEND_API_KEY)" }, 500);
    }

    if (!await consommerQuota(user.id, to.trim())) {
      return json({
        error: `Limite d'envois atteinte (${LIMITE_HORAIRE} par heure). Réessayez plus tard.`,
      }, 429);
    }

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "IT Soluce <contact@itsoluce.be>",
        to: [to.trim()],
        subject: subject,
        html: html,
      }),
    });

    const result = await resendRes.json();

    if (!resendRes.ok) {
      console.error("Resend a refusé l'envoi", { status: resendRes.status, result });
      return json({ error: result.message || "Echec de l'envoi via Resend" }, 502);
    }

    return json({ success: true, id: result.id }, 200);
  } catch (err) {
    console.error("send-reminder", err);
    return json({ error: err instanceof Error ? err.message : "Erreur inconnue" }, 500);
  }
});
