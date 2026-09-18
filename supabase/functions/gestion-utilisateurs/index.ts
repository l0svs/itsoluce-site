// ═══════════════════════════════════════════════════════════
//  IT Soluce — Comptes utilisateurs de l'ERP
//  Edge Function Supabase : gestion-utilisateurs
//
//  SÉCURITÉ — créer un compte exige la clé de service, qui ne doit jamais
//  atteindre un navigateur. Toute la manipulation se fait donc ici, derrière
//  deux verrous successifs :
//
//   1. le jeton présenté doit appartenir à un vrai utilisateur connecté
//      (« verify_jwt » du portail accepte la clé anon, qui est publique) ;
//   2. ce utilisateur doit porter le rôle « proprietaire » dans profils.
//
//  Le second contrôle est fait ICI, côté serveur. Le masquage de la section
//  dans la page Gestion n'est qu'un confort d'interface : il ne protège rien,
//  n'importe qui peut appeler cette fonction directement.
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = new Set([
  "https://itsoluce.be",
  "https://www.itsoluce.be",
]);

// Les pages de l'ERP. Une valeur hors de cette liste est refusée : sans ça,
// un slug fantaisiste s'enregistrerait sans jamais correspondre à une page.
const PAGES = [
  "dashboard", "clients", "demandes", "devis", "factures",
  "reparations", "stock", "catalogue", "planning", "gestion",
];

const MDP_MIN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://itsoluce.be";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

async function utilisateurConnecte(req: Request): Promise<{ id: string; email?: string } | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return null;
    const u = await res.json();
    return u && typeof u.id === "string" ? u : null;
  } catch {
    return null;
  }
}

function admin(chemin: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}${chemin}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function estProprietaire(id: string): Promise<boolean> {
  const res = await admin(`/rest/v1/profils?id=eq.${id}&select=role,actif`);
  if (!res.ok) return false;
  const [p] = await res.json();
  return !!p && p.role === "proprietaire" && p.actif === true;
}

function nettoyerPages(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(String))].filter((p) => PAGES.includes(p));
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

  const moi = await utilisateurConnecte(req);
  if (!moi) return json({ error: "Authentification requise." }, 401);
  if (!(await estProprietaire(moi.id))) {
    return json({ error: "Réservé au propriétaire du compte." }, 403);
  }

  try {
    const corps = await req.json();
    const action = String(corps.action ?? "");

    // ── Lister ──
    if (action === "lister") {
      const res = await admin("/rest/v1/profils?select=*&order=created_at.asc");
      if (!res.ok) return json({ error: "Lecture impossible." }, 500);
      return json({ utilisateurs: await res.json() }, 200);
    }

    // ── Créer ──
    if (action === "creer") {
      const email = String(corps.email ?? "").trim().toLowerCase();
      const mdp = String(corps.mot_de_passe ?? "");
      const nom = String(corps.nom ?? "").trim();
      const pages = nettoyerPages(corps.pages);

      if (!EMAIL_RE.test(email)) return json({ error: "Adresse e-mail invalide." }, 400);
      if (mdp.length < MDP_MIN) {
        return json({ error: `Le mot de passe doit faire au moins ${MDP_MIN} caractères.` }, 400);
      }

      const creation = await admin("/auth/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({ email, password: mdp, email_confirm: true }),
      });
      const cree = await creation.json();
      if (!creation.ok) {
        const msg = String(cree?.msg ?? cree?.message ?? "");
        return json({
          error: /already|exists|registered/i.test(msg)
            ? "Un compte existe déjà avec cette adresse."
            : "Création impossible : " + (msg || creation.status),
        }, 400);
      }

      // Le profil complète le compte Auth. S'il échoue, on retire le compte
      // plutôt que de laisser un utilisateur capable de se connecter sans
      // aucune page autorisée — il verrait une coquille vide sans comprendre.
      const profil = await admin("/rest/v1/profils", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ id: cree.id, nom: nom || email.split("@")[0], email, role: "equipe", pages, actif: true }),
      });
      if (!profil.ok) {
        console.error("Profil non créé, compte Auth retiré", await profil.text());
        await admin(`/auth/v1/admin/users/${cree.id}`, { method: "DELETE" });
        return json({ error: "Création impossible (profil)." }, 500);
      }
      const [p] = await profil.json();
      return json({ utilisateur: p }, 200);
    }

    const cible = String(corps.id ?? "");
    if (!cible) return json({ error: "Utilisateur non précisé." }, 400);

    // ── Modifier nom, pages, activation ──
    if (action === "modifier") {
      // Le propriétaire ne peut pas se retirer ses propres droits : il n'y a
      // personne d'autre pour les lui rendre.
      if (cible === moi.id) {
        return json({ error: "Ton propre compte ne se modifie pas ici." }, 400);
      }
      const maj: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (corps.nom !== undefined) maj.nom = String(corps.nom).trim();
      if (corps.pages !== undefined) maj.pages = nettoyerPages(corps.pages);
      if (corps.actif !== undefined) maj.actif = corps.actif === true;

      const res = await admin(`/rest/v1/profils?id=eq.${cible}&role=eq.equipe`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(maj),
      });
      if (!res.ok) return json({ error: "Modification impossible." }, 500);
      const [p] = await res.json();
      if (!p) return json({ error: "Compte introuvable." }, 404);
      return json({ utilisateur: p }, 200);
    }

    // ── Nouveau mot de passe ──
    if (action === "mot_de_passe") {
      if (cible === moi.id) {
        return json({ error: "Change ton propre mot de passe depuis ton profil." }, 400);
      }
      const mdp = String(corps.mot_de_passe ?? "");
      if (mdp.length < MDP_MIN) {
        return json({ error: `Le mot de passe doit faire au moins ${MDP_MIN} caractères.` }, 400);
      }
      const verif = await admin(`/rest/v1/profils?id=eq.${cible}&select=role`);
      const [p] = verif.ok ? await verif.json() : [];
      if (!p || p.role !== "equipe") return json({ error: "Compte introuvable." }, 404);

      const res = await admin(`/auth/v1/admin/users/${cible}`, {
        method: "PUT",
        body: JSON.stringify({ password: mdp }),
      });
      if (!res.ok) {
        console.error("Mot de passe non changé", await res.text());
        return json({ error: "Changement impossible." }, 500);
      }
      return json({ ok: true }, 200);
    }

    // ── Supprimer ──
    if (action === "supprimer") {
      if (cible === moi.id) return json({ error: "Ton propre compte ne se supprime pas." }, 400);
      const verif = await admin(`/rest/v1/profils?id=eq.${cible}&select=role`);
      const [p] = verif.ok ? await verif.json() : [];
      if (!p || p.role !== "equipe") return json({ error: "Compte introuvable." }, 404);

      // La suppression du compte Auth emporte le profil (clé étrangère
      // on delete cascade) : pas de ligne orpheline à nettoyer.
      const res = await admin(`/auth/v1/admin/users/${cible}`, { method: "DELETE" });
      if (!res.ok) {
        console.error("Suppression impossible", await res.text());
        return json({ error: "Suppression impossible." }, 500);
      }
      return json({ ok: true }, 200);
    }

    return json({ error: "Action inconnue." }, 400);
  } catch (err) {
    console.error("gestion-utilisateurs", err);
    return json({ error: "Erreur serveur." }, 500);
  }
});
