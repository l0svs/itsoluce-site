// ═══════════════════════════════════════════════════════════
//  IT Soluce — Envoi d'un document (facture / devis / diagnostic)
//  Edge Function Supabase : send-invoice
//
//  SÉCURITÉ — pourquoi ce garde-fou existe :
//  Le réglage « verify_jwt » du portail Supabase vérifie seulement que le
//  jeton présenté est signé par le projet. Or la clé « anon » EST un jeton
//  signé par le projet, et elle est publiée en clair dans le code source du
//  site. Sans la vérification ci-dessous, n'importe qui pouvait donc appeler
//  cette fonction et envoyer des e-mails arbitraires depuis contact@itsoluce.be.
//
//  On exige donc un jeton appartenant à un VRAI utilisateur connecté :
//  /auth/v1/user rejette la clé anon (elle n'a pas de « sub »).
// ════════════════════════════════════════════════════════

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Origines autorisées à appeler la fonction depuis un navigateur.
// Note : le CORS ne protège que du navigateur, pas d'un appel curl —
// la vraie protection est la vérification du jeton ci-dessous.
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

/**
 * Renvoie l'utilisateur authentifié, ou null.
 * Appel direct à l'API Auth plutôt qu'au SDK : aucune dépendance CDN à
 * charger, donc aucune surface d'attaque supply-chain côté serveur.
 */
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
    // La clé anon et la clé service_role n'ont pas de « sub » : pas d'id ici.
    return user && typeof user.id === "string" ? user : null;
  } catch {
    return null;
  }
}

// Garde-fous de taille : évitent qu'une session volée serve de canon à spam
// et qu'un corps de requête énorme fasse tomber la fonction.
const MAX_SUBJECT = 300;
const MAX_HTML = 200_000;        // ~200 Ko de HTML
const MAX_PDF_BASE64 = 8_000_000; // ~6 Mo de PDF réel une fois décodé
const MAX_FILENAME = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Une session valide ne suffit pas : le compte doit être actif dans l'ERP et
 * avoir accès à l'une des pages qui utilisent cette fonction (même règle que
 * les politiques RLS). Sans ce contrôle, un compte désactivé — ou un compte
 * créé hors de l'ERP si l'inscription publique était ouverte — pouvait
 * appeler la fonction. La fiche est lue avec la session de l'utilisateur.
 */
async function profilAutorise(
  req: Request, userId: string, pages: string[],
): Promise<{ ecriture: boolean } | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profils?id=eq.${encodeURIComponent(userId)}&select=role,pages,actif,lecture_seule`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` } },
    );
    if (!res.ok) return null;
    const p = (await res.json())[0];
    if (!p || p.actif !== true) return null;
    const proprio = p.role === "proprietaire";
    if (!proprio && !(p.pages || []).some((x: string) => pages.includes(x))) return null;
    return { ecriture: proprio || !p.lecture_seule };
  } catch {
    return null;
  }
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

  // ─── Authentification ───
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ error: "Authentification requise." }, 401);
  }
  const droits = await profilAutorise(req, user.id, ["devis", "factures"]);
  if (!droits || !droits.ecriture) {
    return json({ error: "Compte inactif, en lecture seule ou sans accès aux devis et factures." }, 403);
  }

  try {
    const { to, subject, html, pdfBase64, pdfName } = await req.json();

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
    if (pdfBase64 !== undefined && pdfBase64 !== null) {
      if (typeof pdfBase64 !== "string" || pdfBase64.length > MAX_PDF_BASE64) {
        return json({ error: "Pièce jointe trop volumineuse (6 Mo maximum)." }, 400);
      }
    }
    if (pdfName !== undefined && pdfName !== null) {
      if (typeof pdfName !== "string" || pdfName.length > MAX_FILENAME) {
        return json({ error: "Nom de fichier invalide." }, 400);
      }
    }

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      return json({ error: "Clé API Resend non configurée" }, 500);
    }

    const emailBody: Record<string, unknown> = {
      from: "IT Soluce <contact@itsoluce.be>",
      to: [to.trim()],
      subject: subject,
      html: html || "Veuillez trouver votre document en pièce jointe.",
    };

    // Pièce jointe uniquement si elle est fournie
    if (pdfBase64) {
      emailBody.attachments = [
        {
          filename: pdfName || "document.pdf",
          content: pdfBase64,
        },
      ];
    }

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailBody),
    });

    const result = await resendRes.json();

    if (!resendRes.ok) {
      console.error("Resend a refusé l'envoi", { status: resendRes.status, result });
      return json({ error: "Erreur Resend", details: result }, 500);
    }

    return json({ success: true, id: result.id }, 200);
  } catch (err) {
    console.error("send-invoice", err);
    return json({ error: "Erreur serveur", message: String(err) }, 500);
  }
});
