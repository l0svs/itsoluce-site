// ═══════════════════════════════════════════════════════════
//  IT Soluce — Proxy sécurisé vers l'API Foneday
//  Edge Function Supabase : foneday-proxy
//  Le jeton FONEDAY_TOKEN ne quitte JAMAIS le serveur : le navigateur
//  appelle cette fonction, qui relaie ensuite la requête vers Foneday
//  avec le jeton stocké en secret.
//
//  SÉCURITÉ — voir le commentaire détaillé dans send-invoice/index.ts.
//  « verify_jwt » accepte la clé anon, qui est publique. Sans la
//  vérification ci-dessous, n'importe qui pouvait lire l'historique de
//  commandes, les factures fournisseur (donc les prix d'achat et les marges),
//  les adresses de livraison, et surtout MODIFIER le panier Foneday.
// ════════════════════════════════════════════════════════

const FONEDAY_BASE = "https://foneday.shop/api/v1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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

// Bornes sur les actions qui engagent de l'argent : limite les dégâts
// possibles si une session de l'ERP était un jour compromise.
const MAX_ARTICLES = 50;
const MAX_QUANTITE = 20;

function validerArticles(articles: unknown): string | null {
  if (!Array.isArray(articles) || articles.length === 0) return "articles requis";
  if (articles.length > MAX_ARTICLES) return `Maximum ${MAX_ARTICLES} articles par requête`;
  for (const a of articles) {
    if (!a || typeof a !== "object") return "Article invalide";
    const sku = (a as Record<string, unknown>).sku;
    if (typeof sku !== "string" || sku.length === 0 || sku.length > 100) {
      return "SKU invalide";
    }
    const q = (a as Record<string, unknown>).quantity;
    if (q !== undefined && q !== null) {
      const n = Number(q);
      if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITE) {
        return `Quantité invalide (1 à ${MAX_QUANTITE})`;
      }
    }
  }
  return null;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  // Le navigateur envoie d'abord une requête OPTIONS de « preflight » avant
  // le vrai POST. Il faut y répondre, sinon le POST n'est jamais envoyé.
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Methode non supportee" }, 405);

  // ─── Authentification ───
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ ok: false, error: "Authentification requise." }, 401);
  }

  try {
    const FONEDAY_TOKEN = Deno.env.get("FONEDAY_TOKEN");
    if (!FONEDAY_TOKEN) throw new Error("FONEDAY_TOKEN manquant dans les secrets");

    const body = await req.json();
    const action = body.action;

    let url = "";
    let method = "GET";
    let payload: unknown = undefined;

    switch (action) {
      case "orders":
        url = `${FONEDAY_BASE}/orders`;
        break;
      case "invoices":
        url = `${FONEDAY_BASE}/invoices`;
        break;
      case "invoice-pdf": {
        const num = body.invoice_number;
        if (typeof num !== "string" || !num || num.length > 100) {
          throw new Error("invoice_number requis");
        }
        url = `${FONEDAY_BASE}/invoices/pdf/${encodeURIComponent(num)}`;
        break;
      }
      case "addresses":
        url = `${FONEDAY_BASE}/addresses`;
        break;
      case "cart":
        url = `${FONEDAY_BASE}/shopping-cart`;
        break;
      case "cart-add": {
        const err = validerArticles(body.articles);
        if (err) throw new Error(err);
        url = `${FONEDAY_BASE}/shopping-cart-add-items`;
        method = "POST";
        payload = { articles: body.articles };
        break;
      }
      case "cart-remove": {
        const err = validerArticles(body.articles);
        if (err) throw new Error(err);
        url = `${FONEDAY_BASE}/shopping-cart-remove-items`;
        method = "POST";
        payload = { articles: body.articles };
        break;
      }
      default:
        throw new Error(`Action inconnue : ${action}`);
    }

    const fetchOpts: RequestInit = {
      method,
      headers: {
        "Authorization": `Bearer ${FONEDAY_TOKEN}`,
        "Content-Type": "application/json",
      },
    };
    if (payload) fetchOpts.body = JSON.stringify(payload);

    const resp = await fetch(url, fetchOpts);
    const contentType = resp.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await resp.json() : await resp.text();

    if (!resp.ok) {
      return json({
        ok: false,
        error: (data && (data as Record<string, unknown>).message) || `Erreur Foneday (${resp.status})`,
        status: resp.status,
      }, resp.status);
    }

    return json({ ok: true, data }, 200);
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message || err) }, 500);
  }
});
