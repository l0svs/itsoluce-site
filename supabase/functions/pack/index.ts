// ═══════════════════════════════════════════════════════════
//  IT Soluce — Pack Sérénité : achat en ligne, paiement Mollie,
//  accès à l'espace client, remboursement d'une rétractation.
//  Edge Function Supabase : pack   (verify_jwt = false)
//
//  Actions (POST JSON, sauf le webhook Mollie) :
//   - commander       (visiteur)  crée la commande + le paiement Mollie
//   - lien            (visiteur)  envoie un lien de connexion à l'espace
//   - acces           (ERP)       envoie l'accès espace à un client
//   - rembourser      (ERP)       rembourse une rétractation via Mollie
//   - webhook Mollie  (form « id=tr_… ») : le paiement n'est JAMAIS cru
//     sur parole, il est relu chez Mollie avec la clé secrète.
//
//  Secrets : MOLLIE_API_KEY (test_… ou live_…), RESEND_API_KEY,
//  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY.
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SITE = "https://itsoluce.be";
const EXPEDITEUR = "contact@itsoluce.be";
const QUOTA_ID = "00000000-0000-0000-0000-000000000001";

const ORIGINES = new Set(["https://itsoluce.be", "https://www.itsoluce.be"]);
function cors(o: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": o && ORIGINES.has(o) ? o : SITE,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
class ErreurClient extends Error {
  constructor(msg: string, public statut = 400) { super(msg); }
}

const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
async function rest(chemin: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${chemin}`, { ...init, headers: { ...svc, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${chemin.split("?")[0]} : ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
const rpc = (fn: string, args: unknown) => rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const EUR = new Intl.NumberFormat("fr-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (v: unknown) => EUR.format(Number(v) || 0) + " €";
const dateFr = (d: string | null) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("fr-BE", { day: "numeric", month: "long", year: "numeric" }) : "";

// ── Mollie ───────────────────────────────────────────────
function cleMollie(): string {
  const k = Deno.env.get("MOLLIE_API_KEY") || "";
  if (!/^(test|live)_[A-Za-z0-9]{20,}$/.test(k)) throw new Error("MOLLIE_API_KEY absente ou invalide");
  return k;
}
async function mollie(chemin: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.mollie.com/v2/${chemin}`, {
    ...init,
    headers: { Authorization: `Bearer ${cleMollie()}`, "Content-Type": "application/json" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Mollie ${r.status} : ${j.detail || j.title || "erreur"}`);
  return j;
}

// ── Utilisateur ERP (personnel) ──────────────────────────
async function personnel(req: Request, pages: string[]): Promise<boolean> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt || jwt === ANON_KEY) return false;
  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` } });
  if (!u.ok) return false;
  const { id } = await u.json();
  const p = (await rest(`profils?id=eq.${id}&select=role,pages,actif,lecture_seule`))[0];
  if (!p || !p.actif) return false;
  return p.role === "proprietaire" || (!p.lecture_seule && (p.pages || []).some((x: string) => pages.includes(x)));
}

// ── Quotas d'envoi ───────────────────────────────────────
async function quota(destinataire: string, fonction: string, parAdresse: number): Promise<boolean> {
  const depuis = new Date(Date.now() - 3600_000).toISOString();
  const deja = await rest(`email_envois?select=id&destinataire=eq.${encodeURIComponent(destinataire)}&fonction=eq.${fonction}&created_at=gt.${depuis}`);
  if ((deja || []).length >= parAdresse) return false;
  return (await rpc("enregistrer_envoi_email", { p_user_id: QUOTA_ID, p_destinataire: destinataire, p_fonction: fonction, p_limite: 40 })) !== false;
}

// ── E-mail (Resend, domaine itsoluce.be vérifié) ─────────
async function envoyerMail(a: string, objet: string, html: string) {
  const k = Deno.env.get("RESEND_API_KEY");
  if (!k) throw new Error("RESEND_API_KEY absente");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `IT Soluce <${EXPEDITEUR}>`, reply_to: EXPEDITEUR, to: [a], subject: objet, html }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status} : ${(await r.text()).slice(0, 200)}`);
}
function gabarit(corps: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#12212e;max-width:560px">${corps}` +
    `<p style="margin:18px 0 4px">Bien à vous,</p><p style="margin:0;color:#5a6b7b;font-size:13px">Linton — IT Soluce<br>` +
    `<a href="tel:+32474056659" style="color:#0052CC;text-decoration:none">+32 474 05 66 59</a> · ` +
    `<a href="https://itsoluce.be" style="color:#0052CC;text-decoration:none">itsoluce.be</a></p></div>`;
}
const bouton = (href: string, txt: string) =>
  `<p style="margin:18px 0"><a href="${href}" style="background:#0052CC;color:#fff;text-decoration:none;padding:12px 22px;border-radius:24px;display:inline-block;font-weight:bold">${esc(txt)}</a></p>`;

// ── Compte espace client + lien de connexion ─────────────
async function lienEspace(email: string, clientId: number): Promise<string> {
  const e = email.trim().toLowerCase();
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST", headers: svc, body: JSON.stringify({ type: "magiclink", email: e }),
  });
  let j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Pas encore de compte : on le crée (e-mail confirmé), puis on refait le lien.
    const c = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST", headers: svc, body: JSON.stringify({ email: e, email_confirm: true }),
    });
    if (!c.ok && c.status !== 422) throw new Error(`Création du compte : ${c.status}`);
    const r2 = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: "POST", headers: svc, body: JSON.stringify({ type: "magiclink", email: e }),
    });
    j = await r2.json().catch(() => ({}));
    if (!r2.ok) throw new Error(`Lien de connexion : ${r2.status} ${j.msg || j.error_description || ""}`);
  }
  const userId = j.id || j.user?.id;
  const jeton = j.hashed_token || j.properties?.hashed_token;
  if (!userId || !jeton) throw new Error("Réponse inattendue du service de connexion");
  // Relie le compte au client (une seule fois ; un compte ne change jamais de client).
  const lien = await rest(`clients_comptes?user_id=eq.${userId}&select=client_id`);
  if (!lien.length) {
    const autre = await rest(`clients_comptes?client_id=eq.${clientId}&select=user_id`);
    if (autre.length) throw new Error("Ce client est déjà relié à un autre compte (adresse e-mail modifiée ?)");
    await rest("clients_comptes", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: userId, client_id: clientId }) });
  } else if (Number(lien[0].client_id) !== Number(clientId)) {
    throw new Error("Cette adresse e-mail est déjà reliée à un autre client");
  }
  return `${SITE}/espace.html#t=${encodeURIComponent(jeton)}`;
}

// ═══ Actions ═══════════════════════════════════════════════
const txt = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

async function commander(c: Record<string, unknown>) {
  const formule = txt(c.formule, 20);
  const d = {
    prenom: txt(c.prenom, 60), nom: txt(c.nom, 60), email: txt(c.email, 160).toLowerCase(),
    telephone: txt(c.telephone, 30), adresse: txt(c.adresse, 200),
    societe: txt(c.societe, 120) || null, tva: txt(c.tva, 20) || null,
  };
  if (!d.prenom || !d.nom) throw new ErreurClient("Indiquez votre prénom et votre nom.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) throw new ErreurClient("Adresse e-mail invalide.");
  if (d.telephone.replace(/\D/g, "").length < 8) throw new ErreurClient("Numéro de téléphone invalide.");
  if (d.adresse.length < 8) throw new ErreurClient("Indiquez votre adresse complète (rue, numéro, code postal, commune).");
  if (c.conditions !== true) throw new ErreurClient("Veuillez accepter les conditions du Pack Sérénité.");
  if (c.consentement !== true) throw new ErreurClient("Veuillez confirmer que le service peut commencer tout de suite.");
  const f = (await rest(`pack_formules?code=eq.${encodeURIComponent(formule)}&actif=eq.true&select=code,nom,prix`))[0];
  if (!f) throw new ErreurClient("Formule inconnue.");
  if (!(await quota(d.email, "pack-commande", 5))) throw new ErreurClient("Trop de tentatives. Réessayez dans une heure ou appelez-moi.", 429);

  const cmd = (await rest("pack_commandes", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ...d, formule: f.code, montant: f.prix, consentement: true }),
  }))[0];
  const p = await mollie("payments", {
    method: "POST",
    body: JSON.stringify({
      amount: { currency: "EUR", value: Number(f.prix).toFixed(2) },
      description: `IT Soluce — ${f.nom}`,
      redirectUrl: `${SITE}/pack-merci.html?c=${cmd.id}`,
      webhookUrl: `${SUPABASE_URL}/functions/v1/pack`,
      locale: "fr_BE",
      metadata: { commande: cmd.id },
    }),
  });
  await rest(`pack_commandes?id=eq.${cmd.id}`, { method: "PATCH", body: JSON.stringify({ mollie_payment_id: p.id }) });
  return { url: p._links?.checkout?.href };
}

async function webhook(paymentId: string) {
  if (!/^tr_[A-Za-z0-9]+$/.test(paymentId)) return;
  const p = await mollie(`payments/${paymentId}`);
  const cmdId = p.metadata?.commande;
  if (!cmdId) return;
  if (["failed", "canceled", "expired"].includes(p.status)) {
    await rest(`pack_commandes?id=eq.${cmdId}&statut=eq.cree`, { method: "PATCH", body: JSON.stringify({ statut: "echouee" }) });
    return;
  }
  if (p.status !== "paid") return;
  let r;
  try {
    r = await rpc("finaliser_commande_pack", { p_commande: cmdId, p_payment: p.id, p_montant: Number(p.amount?.value) });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await rest(`pack_commandes?id=eq.${cmdId}`, { method: "PATCH", body: JSON.stringify({ erreur: m.slice(0, 500) }) }).catch(() => {});
    throw e;
  }
  if (r.deja) return;   // déjà traité : Mollie rappelle parfois plusieurs fois
  const cmd = (await rest(`pack_commandes?id=eq.${cmdId}&select=prenom,email`))[0];
  const pack = (await rest(`packs?id=eq.${r.pack_id}&select=nom,date_fin,interventions_total,hydrogels_total,prix`))[0];
  let lien = `${SITE}/espace.html`;
  try { lien = await lienEspace(cmd.email, r.client_id); } catch (e) { console.error("lien espace", e); }
  await envoyerMail(cmd.email, `Votre ${pack.nom} est actif — facture ${r.numero}`, gabarit(
    `<p>Bonjour ${esc(cmd.prenom)},</p>` +
    `<p>Merci pour votre confiance. Votre <b>${esc(pack.nom)}</b> est actif jusqu'au <b>${esc(dateFr(pack.date_fin))}</b> : ` +
    `${pack.interventions_total} interventions incluses, à domicile, sur votre lieu de travail ou en dépôt à Tubize.</p>` +
    `<p>Paiement reçu : ${eur(pack.prix)} · facture <b>${esc(r.numero)}</b>, disponible dans votre espace client.</p>` +
    bouton(lien, "Ouvrir mon espace client") +
    `<p style="color:#5a6b7b;font-size:13px">Ce lien est personnel et valable une heure. Ensuite, demandez simplement un nouveau lien sur itsoluce.be/espace.html avec votre adresse e-mail.</p>` +
    `<p>Pour votre première intervention, appelez-moi ou envoyez-moi un message au +32 474 05 66 59.</p>`,
  )).catch((e) => console.error("mail achat", e));
  await envoyerMail(EXPEDITEUR, `Pack vendu en ligne : ${pack.nom} — ${cmd.prenom}`, gabarit(
    `<p>Nouveau pack payé en ligne : <b>${esc(pack.nom)}</b> (${eur(pack.prix)}), facture ${esc(r.numero)}.</p>` +
    `<p>Client : ${esc(cmd.prenom)} — ${esc(cmd.email)}. Le pack est déjà actif dans l'ERP (Clients › Packs).</p>`,
  )).catch((e) => console.error("mail notification", e));
}

async function lien(c: Record<string, unknown>) {
  const email = txt(c.email, 160).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ErreurClient("Adresse e-mail invalide.");
  // Réponse identique dans tous les cas : on ne révèle pas qui est client.
  const motif = email.replace(/[\\%_]/g, (x) => "\\" + x);
  const cl = (await rest(`clients?select=id,nom&email=ilike.${encodeURIComponent(motif)}&supprime_le=is.null&order=id.asc&limit=1`))[0];
  if (!cl) return { ok: true };
  const aPack = await rest(`packs?select=id&client_id=eq.${cl.id}&statut=in.(actif,retracte,annule)&limit=1`);
  if (!aPack.length) return { ok: true };
  if (!(await quota(email, "pack-lien", 3))) return { ok: true };
  const url = await lienEspace(email, cl.id);
  await envoyerMail(email, "Votre lien de connexion — IT Soluce", gabarit(
    `<p>Bonjour,</p><p>Voici votre lien pour ouvrir votre espace client IT Soluce :</p>` + bouton(url, "Ouvrir mon espace client") +
    `<p style="color:#5a6b7b;font-size:13px">Ce lien est personnel et valable une heure. Si vous n'avez rien demandé, ignorez ce message.</p>`,
  ));
  return { ok: true };
}

async function acces(req: Request, c: Record<string, unknown>) {
  if (!(await personnel(req, ["clients"]))) throw new ErreurClient("Droits insuffisants.", 403);
  const cl = (await rest(`clients?select=id,nom,email&id=eq.${Number(c.client_id)}&supprime_le=is.null`))[0];
  if (!cl) throw new ErreurClient("Client introuvable.");
  if (!cl.email) throw new ErreurClient("Ce client n'a pas d'adresse e-mail.");
  const url = await lienEspace(cl.email, cl.id);
  const prenom = String(cl.nom || "").split(" ")[0];
  await envoyerMail(cl.email, "Votre espace client IT Soluce", gabarit(
    `<p>Bonjour ${esc(prenom)},</p><p>Votre espace client est prêt : vous y suivez votre Pack Sérénité (interventions restantes, historique) et vos factures.</p>` +
    bouton(url, "Ouvrir mon espace client") +
    `<p style="color:#5a6b7b;font-size:13px">Ce lien est valable une heure. Ensuite, demandez un nouveau lien sur itsoluce.be/espace.html avec votre adresse e-mail.</p>`,
  ));
  return { ok: true };
}

async function rembourser(req: Request, c: Record<string, unknown>) {
  if (!(await personnel(req, ["factures"]))) throw new ErreurClient("Droits insuffisants.", 403);
  const p = (await rest(`packs?id=eq.${Number(c.pack_id)}&select=id,statut,mollie_payment_id,mollie_refund_id,note_credit_id,remboursement_montant,nom`))[0];
  if (!p) throw new ErreurClient("Pack introuvable.");
  if (p.statut !== "retracte") throw new ErreurClient("Ce pack n'est pas rétracté.");
  if (p.mollie_refund_id) return { ok: true, deja: true };
  if (!p.mollie_payment_id) throw new ErreurClient("Ce pack n'a pas été payé en ligne : rembourse le client par virement puis marque la note de crédit « remboursée ».");
  const m = Number(p.remboursement_montant) || 0;
  if (m <= 0) throw new ErreurClient("Rien à rembourser.");
  const nc = (await rest(`factures?id=eq.${p.note_credit_id}&select=id,numero,statut`))[0];
  const rf = await mollie(`payments/${p.mollie_payment_id}/refunds`, {
    method: "POST",
    body: JSON.stringify({ amount: { currency: "EUR", value: m.toFixed(2) }, description: `Rétractation ${p.nom} — ${nc?.numero || ""}`.slice(0, 140) }),
  });
  await rest(`packs?id=eq.${p.id}`, { method: "PATCH", body: JSON.stringify({ mollie_refund_id: rf.id, updated_at: new Date().toISOString() }) });
  if (nc && nc.statut === "a_rembourser") {
    await rest(`factures?id=eq.${nc.id}`, { method: "PATCH", body: JSON.stringify({ statut: "remboursee", updated_at: new Date().toISOString() }) });
  }
  return { ok: true, refund: rf.id };
}

// ═══ Point d'entrée ══════════════════════════════════════
Deno.serve(async (req) => {
  const h = cors(req.headers.get("Origin"));
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...h, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json({ error: "Méthode non supportée" }, 405);

  // Webhook Mollie : formulaire « id=tr_… ».
  if ((req.headers.get("Content-Type") || "").includes("application/x-www-form-urlencoded")) {
    try {
      const id = new URLSearchParams(await req.text()).get("id") || "";
      await webhook(id);
      return new Response("ok", { status: 200 });
    } catch (e) {
      console.error("webhook", e instanceof Error ? e.message : e);
      return new Response("erreur", { status: 500 });   // Mollie réessaiera
    }
  }

  let c: Record<string, unknown>;
  try { c = await req.json(); } catch { return json({ error: "Requête illisible" }, 400); }
  try {
    switch (String(c.action || "")) {
      case "commander": return json(await commander(c));
      case "lien": return json(await lien(c));
      case "acces": return json(await acces(req, c));
      case "rembourser": return json(await rembourser(req, c));
      default: return json({ error: "Action inconnue" }, 400);
    }
  } catch (e) {
    if (e instanceof ErreurClient) return json({ error: e.message }, e.statut);
    const m = e instanceof Error ? e.message : String(e);
    console.error("pack", c.action, m);
    const publique = /MOLLIE_API_KEY/.test(m) ? "Le paiement en ligne n'est pas encore activé. Appelez-moi au +32 474 05 66 59." : "Erreur technique, réessayez ou appelez-moi.";
    return json({ error: (c.action === "acces" || c.action === "rembourser") ? m : publique }, 500);
  }
});
