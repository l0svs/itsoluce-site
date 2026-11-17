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

import { facturePdf } from "./pdf.ts";

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
async function envoyerMail(a: string, objet: string, html: string, pieces: { nom: string; octets: Uint8Array }[] = []) {
  const k = Deno.env.get("RESEND_API_KEY");
  if (!k) throw new Error("RESEND_API_KEY absente");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `IT Soluce <${EXPEDITEUR}>`, reply_to: EXPEDITEUR, to: [a], subject: objet, html,
      ...(pieces.length ? { attachments: pieces.map((x) => ({ filename: x.nom, content: base64(x.octets) })) } : {}) }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status} : ${(await r.text()).slice(0, 200)}`);
}
const bouton = (href: string, txt: string) =>
  `<p style="margin:18px 0"><a href="${href}" style="background:#0052CC;color:#fff;text-decoration:none;padding:12px 22px;border-radius:24px;display:inline-block;font-weight:bold">${esc(txt)}</a></p>`;

// ── Facture PDF : génération, archivage légal, envoi ─────
function base64(o: Uint8Array): string {
  let s = "";
  for (let i = 0; i < o.length; i += 0x8000) s += String.fromCharCode(...o.subarray(i, i + 0x8000));
  return btoa(s);
}
async function entreprise(): Promise<Record<string, string>> {
  const l = await rest("settings?select=cle,valeur&cle=in.(entreprise_nom,entreprise_adresse,entreprise_bce,entreprise_email,entreprise_telephone,entreprise_site,finance_mention_tva,finance_iban,mail_modeles_pack)");
  return Object.fromEntries((l || []).map((r: { cle: string; valeur: string }) => [r.cle, String(r.valeur ?? "").trim()]));
}
async function logo(): Promise<Uint8Array | null> {
  try { const r = await fetch(`${SITE}/img/logo-full.png`); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; } catch { return null; }
}
// deno-lint-ignore no-explicit-any
async function pdfDe(f: any): Promise<Uint8Array> { return await facturePdf(f, await entreprise(), await logo()); }
/** Dépose l'original dans les archives (comme l'ERP à l'émission), une seule fois. */
// deno-lint-ignore no-explicit-any
async function archiver(f: any, octets: Uint8Array) {
  if (f.pdf_chemin) return;
  const chemin = `${String(f.date_emission).slice(0, 4)}/${f.numero}.pdf`;
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/factures-archives/${chemin}`, {
    method: "POST", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/pdf", "x-upsert": "false" }, body: octets,
  });
  if (!up.ok && up.status !== 409 && up.status !== 400) throw new Error(`Archive PDF : ${up.status} ${(await up.text()).slice(0, 200)}`);
  let fichier = octets;
  if (!up.ok) {   // déjà déposé lors d'une tentative précédente : c'est ce fichier qui fait foi
    const dl = await fetch(`${SUPABASE_URL}/storage/v1/object/factures-archives/${chemin}`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    if (!dl.ok) throw new Error(`Archive PDF : ${up.status}`);
    fichier = new Uint8Array(await dl.arrayBuffer());
  }
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", fichier));
  const sha = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  await rest(`factures?id=eq.${f.id}`, { method: "PATCH", body: JSON.stringify({ pdf_chemin: chemin, pdf_sha256: sha, pdf_reconstitue: false }) });
}
// Ce que contient le pack, en une phrase (formule Mobile, Famille ou Pro).
// deno-lint-ignore no-explicit-any
async function resumePack(pack: any): Promise<string> {
  if (pack?.formule) {
    try {
      const f = (await rest(`pack_formules?code=eq.${encodeURIComponent(pack.formule)}&select=resume`))[0];
      if (f?.resume) return String(f.resume);
    } catch (e) { console.error("résumé formule", e); }
  }
  const n = Number(pack?.interventions_total) || 0;
  return `${n} intervention${n > 1 ? "s" : ""} incluse${n > 1 ? "s" : ""}, à domicile, sur votre lieu de travail ou en dépôt à Tubize`;
}
// deno-lint-ignore no-explicit-any
async function mailFacture(f: any, octets: Uint8Array, prenom: string, pack: any, lien: string, test = false) {
  await mailClient(f.statut === "payee" ? "pack_achat" : "pack_facture", f.client_email, {
    prenom, pack: pack.nom, date_fin: dateFr(pack.date_fin), interventions: await resumePack(pack),
    facture: f.numero, montant: eur(f.total),
  }, lien, [{ nom: `Facture_${f.numero}.pdf`, octets }], test);
}

// ── Signature et modèles (mêmes que l'ERP : Gestion › Entreprise et › Mails) ──
// Signature : copie de signatureMailHTML (admin/assets/js/signature-mail.js).
function signatureHTML(ent: Record<string, string>): string {
  const nom = ent.entreprise_nom || "IT Soluce", tel = ent.entreprise_telephone || "+32 474 05 66 59";
  const email = ent.entreprise_email || "contact@itsoluce.be";
  const site = (ent.entreprise_site || "itsoluce.be").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const adr = ent.entreprise_adresse || "Chaussée d'Hondzocht 164, 1480 Tubize", bce = ent.entreprise_bce || "BE 1027.026.003";
  const L = (href: string, t: string, c: string) => `<a href="${href}" style="color:${c};text-decoration:none;">${esc(t)}</a>`;
  const pied = [esc(adr), bce ? "BCE " + esc(bce) : ""].filter(Boolean).join(" &middot; ");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#12212e;margin:18px 0 14px;">Bien &agrave; vous,</div>` +
    `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">` +
    `<tr><td style="padding:0 0 10px;"><img src="https://itsoluce.be/img/logo-full.png" width="78" height="32" alt="${esc(nom)}" style="display:block;border:0;"></td></tr>` +
    `<tr><td style="border-top:2px solid #0052CC;padding:9px 0 0;font-size:13px;font-weight:bold;color:#12212e;">R&eacute;paration informatique</td></tr>` +
    `<tr><td style="padding:8px 0 0;font-size:12.5px;line-height:1.9;color:#5a6b7b;">` +
    `<span style="color:#0052CC;font-weight:bold;">T</span>&nbsp;&nbsp;${L("tel:" + tel.replace(/[^0-9+]/g, ""), tel, "#5a6b7b")}<br>` +
    `<span style="color:#0052CC;font-weight:bold;">E</span>&nbsp;&nbsp;${L("mailto:" + email, email, "#5a6b7b")}<br>` +
    `<span style="color:#0052CC;font-weight:bold;">W</span>&nbsp;&nbsp;${L("https://" + site + "/", site, "#0052CC")}</td></tr>` +
    `<tr><td style="padding:9px 0 0;font-size:11.5px;line-height:1.6;color:#8a97a3;">${pied}</td></tr></table>`;
}
// Textes par défaut : identiques à MAIL_MODELES_PACK_DEFAUT (admin/assets/js/mail-modeles.js).
const MODELES: Record<string, { objet: string; corps: string }> = {
  pack_achat: { objet: "Votre {pack} est actif — facture {facture}",
    corps: "Bonjour {prenom},\n\nMerci pour votre confiance.\nVotre {pack} est actif jusqu'au {date_fin} : {interventions}.\n\nVous trouverez votre facture {facture} ({montant}, payée) en pièce jointe.\n\n{lien_espace}\n\nPour votre première intervention, appelez-moi ou répondez simplement à ce mail." },
  pack_facture: { objet: "Votre {pack} — facture {facture}",
    corps: "Bonjour {prenom},\n\nVous trouverez en pièce jointe la facture {facture} de votre {pack} : {montant} à régler par virement sur le compte {iban} (communication : {facture}).\n\nVotre pack s'active dès réception du paiement." },
  pack_lien: { objet: "Votre lien de connexion — IT Soluce",
    corps: "Bonjour,\n\nVoici votre lien pour ouvrir votre espace client IT Soluce :\n\n{lien_espace}\n\nSi vous n'avez rien demandé, ignorez simplement ce message." },
  pack_acces: { objet: "Votre espace client IT Soluce",
    corps: "Bonjour {prenom},\n\nVotre espace client est prêt : vous y suivez votre Pack Sérénité (interventions restantes, historique) et vos factures.\n\n{lien_espace}" },
};
/** Envoie le mail « cle » au client : texte de Gestion › Mails, signature de l'ERP. */
async function mailClient(cle: string, a: string, v: Record<string, string>, lien: string, pieces: { nom: string; octets: Uint8Array }[] = [], test = false) {
  const ent = await entreprise();
  let perso: Record<string, { objet?: string; corps?: string }> = {};
  try { perso = JSON.parse(ent.mail_modeles_pack || "{}") || {}; } catch { perso = {}; }
  const m = { ...MODELES[cle], ...Object.fromEntries(Object.entries(perso[cle] || {}).filter(([, x]) => String(x ?? "").trim())) };
  const val = { ...v, iban: ent.finance_iban || "" };
  const remplir = (t: string, html: boolean) => t.replace(/\{(\w+)\}/g, (x, k) => k === "lien_espace" ? x : (k in val ? (html ? esc(val[k]) : val[k]) : x));
  const objet = (test ? "[TEST] " : "") + remplir(m.objet, false).replace(/[\r\n]+/g, " ").trim();
  const btn = lien ? bouton(lien, "Ouvrir mon espace client") +
    `<p style="margin:0 0 12px;color:#5a6b7b;font-size:13px">Ce lien est personnel et valable une heure. Ensuite, demandez un nouveau lien sur itsoluce.be/espace.html avec votre adresse e-mail.</p>` : "";
  const corps = esc(m.corps).split(/\n{2,}/).map((p) => {
    const t = remplir(p.trim(), true);
    if (t === "{lien_espace}") return btn;
    return `<p style="margin:0 0 12px;">${t.replace(/\{lien_espace\}/g, "").replace(/\n/g, "<br>")}</p>`;
  }).join("");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#12212e;max-width:560px">${corps}${signatureHTML(ent)}</div>`;
  await envoyerMail(a, objet, html, pieces);
}

/** Notification interne (contact@itsoluce.be) : récapitulatif d'un pack payé en ligne. */
// deno-lint-ignore no-explicit-any
async function mailNotification(o: { cmd: any; pack: any; packId: number | null; facture: string; envoiOk: boolean; paiement: string; test?: boolean }) {
  const ent = await entreprise();
  const td = "padding:7px 0;border-bottom:1px solid #e3e8ee;font-size:14px;vertical-align:top;";
  const ligne = (k: string, v: string) => v ? `<tr><td style="${td}color:#5a6b7b;width:150px;">${esc(k)}</td><td style="${td}">${v}</td></tr>` : "";
  const nom = `${o.cmd.prenom || ""} ${o.cmd.nom || ""}`.trim();
  const tel = String(o.cmd.telephone || "");
  const corps =
    `<p style="margin:0 0 12px;">${o.test ? "<b>Paiement de test</b> (rien n'a été enregistré)." : "Bonne nouvelle : un Pack Sérénité vient d'être payé en ligne."}</p>` +
    `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;width:100%;max-width:520px;margin:4px 0 14px;">` +
    ligne("Client", `<b>${esc(nom)}</b>${o.cmd.societe ? " · " + esc(o.cmd.societe) : ""}`) +
    ligne("E-mail", o.cmd.email ? `<a href="mailto:${esc(o.cmd.email)}" style="color:#0052CC;text-decoration:none;">${esc(o.cmd.email)}</a>` : "") +
    ligne("Téléphone", tel ? `<a href="tel:${esc(tel.replace(/[^0-9+]/g, ""))}" style="color:#0052CC;text-decoration:none;">${esc(tel)}</a>` : "") +
    ligne("Adresse", esc(o.cmd.adresse || "")) +
    ligne("TVA", esc(o.cmd.tva || "")) +
    ligne("Formule", `<b>${esc(o.pack?.nom || "")}</b>`) +
    ligne("Montant payé", `<b>${eur(o.pack?.prix)}</b> · paiement en ligne (Mollie ${esc(o.paiement)})`) +
    ligne("Facture", esc(o.facture || "")) +
    ligne("Valable jusqu'au", esc(dateFr(o.pack?.date_fin))) +
    `</table>` +
    (o.test ? "" : o.envoiOk
      ? `<p style="margin:0 0 12px;">La facture a été archivée et envoyée au client avec le lien vers son espace client.</p>`
      : `<p style="margin:0 0 12px;color:#9a5b00;"><b>Attention :</b> l'envoi de la facture au client a échoué. Envoie-la depuis l'ERP (Factures).</p>`) +
    (o.packId ? bouton(`${SITE}/admin/packs.html?pack=${o.packId}`, "Ouvrir le pack dans l'ERP") : "");
  const objet = `${o.test ? "[TEST] " : ""}Pack vendu en ligne : ${o.pack?.nom || "Pack Sérénité"} — ${nom}`;
  await envoyerMail(EXPEDITEUR, objet, `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#12212e;max-width:560px">${corps}${signatureHTML(ent)}</div>`);
}

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
  cleMollie();   // paiement non configuré : on s'arrête avant d'enregistrer quoi que ce soit
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
  if (p.mode === "test") {
    // Paiement de test : parcours complet simulé puis annulé en base,
    // aucune facture ni aucun numéro consommé.
    const sim = await rpc("simuler_commande_pack", { p_commande: cmdId, p_payment: p.id, p_montant: Number(p.amount?.value) });
    try {
      const f = sim.facture, octets = await pdfDe(f);
      const cmdT = (await rest(`pack_commandes?id=eq.${cmdId}&select=prenom`))[0];
      await mailFacture(f, octets, cmdT?.prenom || "", sim.pack, "", true);
    } catch (e) { console.error("facture test", e); }
    const cmdN = (await rest(`pack_commandes?id=eq.${cmdId}&select=prenom,nom,email,telephone,adresse,societe,tva`))[0] || {};
    await mailNotification({ cmd: cmdN, pack: sim?.pack, packId: null, facture: `${sim?.numero || ""} (non attribué : test)`, envoiOk: true, paiement: p.id, test: true })
      .catch((e) => console.error("mail test", e));
    return;
  }
  let r;
  try {
    r = await rpc("finaliser_commande_pack", { p_commande: cmdId, p_payment: p.id, p_montant: Number(p.amount?.value) });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await rest(`pack_commandes?id=eq.${cmdId}`, { method: "PATCH", body: JSON.stringify({ erreur: m.slice(0, 500) }) }).catch(() => {});
    throw e;
  }
  if (r.deja) return;   // déjà traité : Mollie rappelle parfois plusieurs fois
  const cmd = (await rest(`pack_commandes?id=eq.${cmdId}&select=prenom,nom,email,telephone,adresse,societe,tva`))[0];
  const pack = (await rest(`packs?id=eq.${r.pack_id}&select=nom,formule,date_fin,interventions_total,hydrogels_total,prix`))[0];
  const fac = (await rest(`factures?id=eq.${r.facture_id}&select=*`))[0];
  let lien = `${SITE}/espace.html`;
  try { lien = await lienEspace(cmd.email, r.client_id); } catch (e) { console.error("lien espace", e); }
  let envoiOk = false;
  try {
    const octets = await pdfDe(fac);
    try { await archiver(fac, octets); } catch (e) { console.error("archive", e); }
    await mailFacture(fac, octets, cmd.prenom, pack, lien);
    envoiOk = true;
  } catch (e) { console.error("mail facture", e); }
  await mailNotification({ cmd, pack, packId: r.pack_id, facture: r.numero, envoiOk, paiement: p.id })
    .catch((e) => console.error("mail notification", e));
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
  await mailClient("pack_lien", email, {}, url);
  return { ok: true };
}

async function acces(req: Request, c: Record<string, unknown>) {
  if (!(await personnel(req, ["clients"]))) throw new ErreurClient("Droits insuffisants.", 403);
  const cl = (await rest(`clients?select=id,nom,email&id=eq.${Number(c.client_id)}&supprime_le=is.null`))[0];
  if (!cl) throw new ErreurClient("Client introuvable.");
  if (!cl.email) throw new ErreurClient("Ce client n'a pas d'adresse e-mail.");
  const url = await lienEspace(cl.email, cl.id);
  const prenom = String(cl.nom || "").split(" ")[0];
  await mailClient("pack_acces", cl.email, { prenom }, url);

  return { ok: true };
}

async function envoyerFacturePack(req: Request, c: Record<string, unknown>) {
  if (!(await personnel(req, ["factures"]))) throw new ErreurClient("Droits insuffisants.", 403);
  const pk = (await rest(`packs?id=eq.${Number(c.pack_id)}&select=id,client_id,nom,formule,date_fin,interventions_total,facture_id,statut`))[0];
  if (!pk || !pk.facture_id) throw new ErreurClient("Pack introuvable.");
  const fac = (await rest(`factures?id=eq.${pk.facture_id}&select=*`))[0];
  if (!fac || !fac.numero) throw new ErreurClient("Facture introuvable.");
  const octets = await pdfDe(fac);
  await archiver(fac, octets);
  if (!fac.client_email) return { ok: true, archive: true, envoye: false };
  let lien = "";
  if (pk.statut === "actif") { try { lien = await lienEspace(fac.client_email, pk.client_id); } catch (e) { console.error("lien espace", e); } }
  await mailFacture(fac, octets, String(fac.client_nom || "").split(" ")[0], pk, lien);
  await rest(`factures?id=eq.${fac.id}`, { method: "PATCH", body: JSON.stringify({ email_envoye: true, date_envoi: new Date().toISOString() }) }).catch(() => {});
  return { ok: true, archive: true, envoye: true };
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
      case "envoyer_facture": return json(await envoyerFacturePack(req, c));
      default: return json({ error: "Action inconnue" }, 400);
    }
  } catch (e) {
    if (e instanceof ErreurClient) return json({ error: e.message }, e.statut);
    const m = e instanceof Error ? e.message : String(e);
    console.error("pack", c.action, m);
    const publique = /MOLLIE_API_KEY/.test(m) ? "Le paiement en ligne n'est pas encore activé. Appelez-moi au +32 474 05 66 59." : "Erreur technique, réessayez ou appelez-moi.";
    return json({ error: (["acces", "rembourser", "envoyer_facture"].includes(String(c.action))) ? m : publique }, 500);
  }
});
