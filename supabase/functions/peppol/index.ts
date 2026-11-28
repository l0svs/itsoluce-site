// ═══════════════════════════════════════════════════════════
//  IT Soluce — Envoi des factures via Peppol (point d'accès Recommand)
//  Edge Function Supabase : peppol   (verify_jwt = false, contrôle ci-dessous)
//
//  Actions (POST JSON) :
//   - verifier    (ERP, interne)  le client (n° de TVA belge) est-il sur Peppol ?
//   - envoyer     (ERP, interne)  envoie UNE SEULE FOIS une facture encaissée
//                                 (ou une note de crédit réglée) au client pro
//   - statut      (ERP, interne)  met à jour la livraison d'une facture
//   - suivre      (interne, cron) met à jour toutes les livraisons en attente
//   - controle    (interne)       formulaire Pack du site : vérifie l'entreprise et
//                                 fait valider une facture à blanc (rien n'est envoyé)
//   - apercu      (interne)       facture réelle → document Peppol validé à blanc
//
//  Dès que la livraison est confirmée, le client reçoit un mail « votre facture vous a
//  été transmise via Peppol » (une seule fois, colonne peppol_mail_le ; texte modifiable :
//  réglage mail_modele_peppol, Gestion › Mails). Les Packs du site envoient leur propre
//  mail : la fonction pack appelle « envoyer » avec attendre:false, et aucun mail ne part ici.
//
//  Une facture ne part qu'une seule fois : peppol_reserver() (base) n'accorde
//  l'envoi qu'à un seul appel ; un résultat incertain n'est jamais renvoyé
//  automatiquement (on cherche d'abord le document chez Recommand) ; une facture
//  livrée ne repart jamais (trigger trg_peppol_garde).
//
//  Accès Recommand : table recommand_acces (lue avec la clé de service).
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const API = "https://app.recommand.eu/api/v1";
const SITE = "https://itsoluce.be";
const ORIGINES = new Set(["https://itsoluce.be", "https://www.itsoluce.be"]);
const TVA_E = { category: "E", percentage: "0.00" };

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
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const m2 = (n: number) => r2(n).toFixed(2);

// ── Accès : personnel ERP, ou appel interne (cron, fonction pack) ─────
function egal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function interne(req: Request): Promise<boolean> {
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (bearer && egal(bearer, SERVICE_KEY)) return true;
  const recu = req.headers.get("x-sync-jeton") ?? "";
  if (recu.length < 32) return false;
  const lj = (await rest("sync_jeton?select=jeton&id=eq.1"))?.[0];
  return !!lj && egal(recu, String(lj.jeton));
}
async function personnel(req: Request): Promise<boolean> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt || jwt === ANON_KEY) return false;
  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` } });
  if (!u.ok) return false;
  const { id } = await u.json();
  const p = (await rest(`profils?id=eq.${id}&select=role,pages,actif,lecture_seule`))[0];
  if (!p || !p.actif) return false;
  return p.role === "proprietaire" || (!p.lecture_seule && (p.pages || []).includes("factures"));
}

// ── Recommand ────────────────────────────────────────────
type Acces = { cle: string; secret: string; entreprise: string };
const _acces: Record<string, Acces> = {};
async function acces(mode: "production" | "test"): Promise<Acces> {
  if (!_acces[mode]) {
    const a = (await rest(`recommand_acces?mode=eq.${mode}&select=cle,secret,entreprise`))?.[0];
    if (!a) throw new Error(`Accès Recommand (${mode}) non configuré`);
    _acces[mode] = a;
  }
  return _acces[mode];
}
/** Appel à Recommand. Une coupure réseau lève RESEAU (résultat inconnu). */
class Reseau extends Error {}
// deno-lint-ignore no-explicit-any
async function rc(mode: "production" | "test", chemin: string, init: RequestInit = {}): Promise<{ status: number; j: any }> {
  const a = await acces(mode);
  let r: Response;
  try {
    r = await fetch(`${API}${chemin}`, {
      ...init,
      signal: AbortSignal.timeout(50_000),
      headers: { Authorization: "Basic " + btoa(`${a.cle}:${a.secret}`), "Content-Type": "application/json", ...(init.headers || {}) },
    });
  } catch (e) { throw new Reseau(String(e instanceof Error ? e.message : e)); }
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = { brut: t.slice(0, 300) }; }
  return { status: r.status, j };
}

// ── Numéro d'entreprise belge (contrôle modulo 97) ───────
function numeroBE(tva: unknown): string {
  let n = String(tva ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (n.startsWith("BE")) n = n.slice(2);
  if (/^\d{9}$/.test(n)) n = "0" + n;
  if (!/^[01]\d{9}$/.test(n)) return "";
  return 97 - (Number(n.slice(0, 8)) % 97) === Number(n.slice(8)) ? n : "";
}

/** Le client est-il joignable sur Peppol ? (adresse 0208, puis 9925 = n° de TVA) */
async function surPeppol(mode: "production" | "test", n: string): Promise<{ inscrit: boolean; participant: string | null; nom: string | null }> {
  for (const adr of [`0208:${n}`, `9925:be${n}`]) {
    const { status, j } = await rc(mode, "/verify", { method: "POST", body: JSON.stringify({ peppolAddress: adr, includeBusinessCard: true }) });
    if (status >= 500) throw new Error("Recommand indisponible, réessaie dans un instant.");
    if (j?.isValid) {
      const bc = j.businessCard || {};
      const nom = bc?.entities?.[0]?.name?.[0]?.name || bc?.name || bc?.entities?.[0]?.name || null;
      return { inscrit: true, participant: adr, nom: typeof nom === "string" ? nom : null };
    }
  }
  return { inscrit: false, participant: null, nom: null };
}

// ── Adresse « Rue et numéro, 1480 Tubize » → rue, code postal, commune ─
function adresse(s: unknown): { street: string; postalZone: string; city: string } | null {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(.*?)[\s,]+([1-9]\d{3})\s+([^\d,][^,]*?)\s*(?:,\s*(?:Belgique|Belgium|België|BE))?\s*$/i);
  if (!m) return null;
  const street = m[1].replace(/[\s,]+$/, "").trim();
  if (street.length < 3) return null;
  return { street, postalZone: m[2], city: m[3].trim() };
}

// ── Réglages (mention de franchise TVA) ──────────────────
async function mentionTva(): Promise<string> {
  const l = await rest("settings?select=valeur&cle=eq.finance_mention_tva");
  return String(l?.[0]?.valeur || "").trim() || "TVA non applicable, article 56bis du Code TVA";
}

const MODES: Record<string, string> = { especes: "espèces", carte: "carte bancaire", virement: "virement", mixte: "carte et espèces", bancontact: "Bancontact", payconiq: "Payconiq", en_ligne: "paiement en ligne" };
const dateFr = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("fr-BE", { day: "2-digit", month: "2-digit", year: "numeric" });

type Ligne = { description?: string; quantite?: number | string; prix_unitaire?: number | string; total?: number | string };
/** Lignes de l'ERP → lignes Peppol (prix jamais négatif : le signe passe dans la quantité). */
function lignesPeppol(lignes: Ligne[], signe: 1 | -1) {
  const out = [];
  let somme = 0;
  for (const l of lignes || []) {
    const txt = String(l.description || "").trim();
    if (!txt) continue;
    const q = Number(l.quantite) || 1;
    const pu = Number(l.prix_unitaire) || 0;
    const tot = r2((l.total != null && l.total !== "" ? Number(l.total) : q * pu) * signe);
    let quantite = Math.abs(q) * (tot < 0 ? -1 : 1), prix = Math.abs(pu);
    if (Math.abs(r2(quantite * prix) - tot) > 0.005) { quantite = tot < 0 ? -1 : 1; prix = Math.abs(tot); }
    const [nom, ...reste] = txt.split(/\n+/);
    const ligne: Record<string, unknown> = {
      name: nom.slice(0, 250), quantity: m2(quantite), unitCode: "C62", netPriceAmount: m2(prix), netAmount: m2(tot), vat: TVA_E,
    };
    if (reste.length) ligne.description = reste.join(" ").slice(0, 1000);
    out.push(ligne);
    somme = r2(somme + tot);
  }
  return { lignes: out, somme };
}

// deno-lint-ignore no-explicit-any
type Facture = Record<string, any>;
/** Facture de l'ERP → document Recommand (invoice ou creditNote). Lève ErreurClient si incomplet. */
function construire(f: Facture, origine: Facture | null, mention: string, participant: string, pdf: string | null) {
  const nc = f.type_document === "note_credit";
  const n = numeroBE(f.client_tva);
  if (!n) throw new ErreurClient("Numéro de TVA du client invalide : Peppol n'est possible que pour une entreprise belge (BE + 10 chiffres valides).");
  const adr = adresse(f.client_adresse);
  if (!adr) throw new ErreurClient("Adresse du client incomplète : il faut « rue et numéro, code postal et commune » (ex. : Rue de la Station 12, 1480 Tubize).");
  const { lignes, somme } = lignesPeppol(f.lignes || [], nc ? -1 : 1);
  if (!lignes.length) throw new ErreurClient("Aucune ligne à facturer.");
  const remise = nc ? 0 : r2(Number(f.remise) || 0);
  const total = r2(Math.abs(Number(f.total) || 0));
  const calcule = r2(somme - remise);
  if (Math.abs(calcule - total) > 0.01) throw new ErreurClient(`Montants incohérents : lignes ${m2(somme)} €, remise ${m2(remise)} €, total ${m2(total)} €.`);
  const regle = f.date_paiement ? ` le ${dateFr(f.date_paiement)}` : "";
  const mode = f.mode_paiement ? ` (${MODES[f.mode_paiement] || f.mode_paiement})` : "";
  const note = [mention, f.notes ? String(f.notes).trim() : "", nc ? (f.motif_credit ? `Motif : ${String(f.motif_credit).trim()}` : "") : `Facture acquittée${regle}${mode}.`]
    .filter(Boolean).join("\n");
  const buyer: Record<string, unknown> = {
    name: String(f.client_societe || f.client_nom || "").trim(), ...adr, country: "BE",
    vatNumber: "BE" + n, enterpriseNumber: n, enterpriseNumberScheme: "0208",
  };
  if (f.client_email) buyer.email = String(f.client_email).trim();
  const doc: Record<string, unknown> = {
    issueDate: f.date_emission, currency: "EUR", note, buyer, lines: lignes,
    vat: { exemptionReason: mention },
    totals: {
      linesAmount: m2(somme), discountAmount: m2(remise), taxExclusiveAmount: m2(total), taxInclusiveAmount: m2(total),
      paidAmount: m2(total), payableAmount: "0.00",
    },
  };
  if (remise > 0) doc.discounts = [{ amount: m2(remise), reason: "Remise", vat: TVA_E }];
  if (f.date_echeance && f.date_echeance >= f.date_emission) doc.dueDate = f.date_echeance;
  if (pdf) doc.attachments = [{
    id: f.numero, mimeCode: "application/pdf", filename: `${nc ? "Note_de_credit" : "Facture"}_${f.numero}.pdf`,
    description: nc ? "Note de crédit (PDF)" : "Facture (PDF)", embeddedDocument: pdf,
  }];
  if (nc) {
    if (!origine?.numero) throw new ErreurClient("Facture d'origine introuvable pour cette note de crédit.");
    doc.creditNoteNumber = f.numero;
    doc.invoiceReferences = [{ id: origine.numero, issueDate: origine.date_emission }];
  } else doc.invoiceNumber = f.numero;
  return { recipient: participant, documentType: nc ? "creditNote" : "invoice", document: doc };
}

async function pdfArchive(f: Facture): Promise<string> {
  if (!f.pdf_chemin) throw new ErreurClient("Le PDF de la facture n'est pas encore archivé : archive-le d'abord (lien « archiver » en haut de la page Factures).");
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/factures-archives/${f.pdf_chemin}`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!r.ok) throw new ErreurClient("PDF archivé introuvable : archive-le d'abord.");
  const b = new Uint8Array(await r.arrayBuffer());
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

// ── Statuts ──────────────────────────────────────────────
const RAISONS: Record<string, string> = {
  recipient_not_found: "le client n'est pas (ou plus) inscrit sur Peppol",
  document_not_supported: "le client n'accepte pas ce type de document sur Peppol",
  validation: "la facture a été refusée par les contrôles Peppol",
  transport: "la transmission sur le réseau Peppol a échoué",
  recipient_rejected: "le client a refusé la facture",
  duplicate: "le client a déjà reçu un document avec ce numéro",
  other: "erreur Peppol",
};
// deno-lint-ignore no-explicit-any
function raison(j: any): string {
  const morceaux: string[] = [];
  const f = j?.deliveryFailure || j?.failure;
  if (f?.category) morceaux.push(RAISONS[f.category] || f.category);
  const e = j?.errors;
  if (e && typeof e === "object") for (const [k, v] of Object.entries(e)) morceaux.push(`${k === "root" ? "" : k + " : "}${Array.isArray(v) ? v.join(" ; ") : v}`);
  if (f?.message) morceaux.push(f.message);
  return (morceaux.filter(Boolean).join(" — ") || "erreur inconnue").slice(0, 600);
}
// deno-lint-ignore no-explicit-any
function etatDocument(d: any): { statut: string; erreur: string | null } {
  if (d?.deliveryStatus === "delivered") return { statut: "livree", erreur: null };
  if (d?.deliveryStatus === "failed") {
    const echec = (d.deliveries || []).find((x: { status: string }) => x.status === "failed");
    // Le client a déjà ce numéro : quelque chose est arrivé chez lui, ne pas renvoyer à l'aveugle.
    if (echec?.failure?.category === "duplicate") return { statut: "incertain", erreur: "Recommand signale un doublon : le client a peut-être déjà reçu cette facture. Vérifie avant tout nouvel envoi." };
    return { statut: "echec", erreur: "Échec de livraison : " + raison({ failure: echec?.failure }) };
  }
  return { statut: "en_cours", erreur: null };
}
const COLS = "id,numero,statut,type_document,peppol_statut,peppol_document_id,peppol_envoye_le,peppol_livree_le,peppol_destinataire,peppol_erreur,peppol_mail_le";
async function maj(id: number, champs: Record<string, unknown>): Promise<Facture> {
  return (await rest(`factures?id=eq.${id}&select=${COLS}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(champs) }))[0];
}
const lire = async (id: number) => (await rest(`factures?id=eq.${id}&select=*`))?.[0] as Facture | undefined;

// ── Mail au client après la livraison Peppol (une seule fois) ──
const EXPEDITEUR = "contact@itsoluce.be";
// Texte par défaut : identique à MAIL_MODELE_PEPPOL_DEFAUT (admin/assets/js/mail-modeles.js).
const MAIL_DEFAUT = {
  objet: "Votre {document} {numero} vous a été transmise via Peppol",
  corps: "Bonjour {prenom},\n\nVotre {document} {numero} du {date} ({montant}) vous a été transmise via Peppol.\n\nMerci pour votre confiance.",
};
const escH = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const EUR = new Intl.NumberFormat("fr-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateLongue = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("fr-BE", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Brussels" });
async function reglagesMail(): Promise<Record<string, string>> {
  const l = await rest("settings?select=cle,valeur&cle=in.(entreprise_nom,entreprise_adresse,entreprise_bce,entreprise_email,entreprise_telephone,entreprise_site,mail_modele_peppol)");
  return Object.fromEntries((l || []).map((r: { cle: string; valeur: string }) => [r.cle, String(r.valeur ?? "").trim()]));
}
// Signature : la même que les autres mails automatiques (copie de signatureMailHTML de l'ERP).
function signatureHTML(ent: Record<string, string>): string {
  const nom = ent.entreprise_nom || "IT Soluce", tel = ent.entreprise_telephone || "+32 474 05 66 59";
  const email = ent.entreprise_email || "contact@itsoluce.be";
  const site = (ent.entreprise_site || "itsoluce.be").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const adr = ent.entreprise_adresse || "Chaussée d'Hondzocht 164, 1480 Tubize", bce = ent.entreprise_bce || "BE 1027.026.003";
  const L = (href: string, t: string, c: string) => `<a href="${href}" style="color:${c};text-decoration:none;">${escH(t)}</a>`;
  const pied = [escH(adr), bce ? "BCE " + escH(bce) : ""].filter(Boolean).join(" &middot; ");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#12212e;margin:18px 0 14px;">Bien &agrave; vous,</div>` +
    `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">` +
    `<tr><td style="padding:0 0 10px;"><img src="https://itsoluce.be/img/logo-full.png" width="78" height="32" alt="${escH(nom)}" style="display:block;border:0;"></td></tr>` +
    `<tr><td style="border-top:2px solid #0052CC;padding:9px 0 0;font-size:13px;font-weight:bold;color:#12212e;">R&eacute;paration informatique</td></tr>` +
    `<tr><td style="padding:8px 0 0;font-size:12.5px;line-height:1.9;color:#5a6b7b;">` +
    `<span style="color:#0052CC;font-weight:bold;">T</span>&nbsp;&nbsp;${L("tel:" + tel.replace(/[^0-9+]/g, ""), tel, "#5a6b7b")}<br>` +
    `<span style="color:#0052CC;font-weight:bold;">E</span>&nbsp;&nbsp;${L("mailto:" + email, email, "#5a6b7b")}<br>` +
    `<span style="color:#0052CC;font-weight:bold;">W</span>&nbsp;&nbsp;${L("https://" + site + "/", site, "#0052CC")}</td></tr>` +
    `<tr><td style="padding:9px 0 0;font-size:11.5px;line-height:1.6;color:#8a97a3;">${pied}</td></tr></table>`;
}
/** Objet et corps HTML du mail « transmise via Peppol » (une ligne vide sépare les paragraphes). */
function mailPeppol(f: Facture, modele: { objet: string; corps: string }, ent: Record<string, string>) {
  const nc = f.type_document === "note_credit";
  const nom = String(f.client_nom || "").trim(), soc = String(f.client_societe || "").trim();
  const v: Record<string, string> = {
    prenom: !nom || (soc && nom === soc) ? "" : nom.split(/\s+/)[0],
    document: nc ? "note de crédit" : "facture", numero: String(f.numero || ""),
    date: f.date_emission ? dateLongue(f.date_emission) : "", montant: EUR.format(Math.abs(Number(f.total) || 0)) + " €",
    societe: soc || nom,
  };
  // Entreprise sans personne de contact : « Bonjour, ».
  const corps = v.prenom ? modele.corps : modele.corps.replace(/Bonjour \{prenom\},/g, "Bonjour,");
  const remplir = (t: string, html: boolean) => t.replace(/\{(\w+)\}/g, (x, k) => (k in v ? (html ? escH(v[k]) : v[k]) : x));
  const o = remplir(modele.objet, false).replace(/[\r\n]+/g, " ").trim();
  const objet = o.charAt(0).toUpperCase() + o.slice(1);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#12212e;max-width:560px">` +
    corps.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${remplir(escH(p.trim()), true).replace(/\n/g, "<br>")}</p>`).join("") +
    signatureHTML(ent) + `</div>`;
  return { objet, html };
}
async function envoyerMail(a: string, objet: string, html: string) {
  const k = Deno.env.get("RESEND_API_KEY");
  if (!k) throw new Error("RESEND_API_KEY absente");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `IT Soluce <${EXPEDITEUR}>`, reply_to: EXPEDITEUR, to: [a], subject: objet, html }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status} : ${(await r.text()).slice(0, 200)}`);
  // Copie dans « Envoyés » de contact@itsoluce.be ; un échec n'annule pas l'envoi.
  try {
    const c = await fetch(`${SUPABASE_URL}/functions/v1/mail-copie`, {
      method: "POST", headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ a, objet, html, pieces: [] }),
    });
    if (!c.ok) console.error("copie Envoyés", c.status);
  } catch (e) { console.error("copie Envoyés", e); }
}
/** Livraison confirmée : prévient le client par mail, une seule fois (réservation sur peppol_mail_le). */
async function prevenir(id: number): Promise<void> {
  const f = await lire(id);
  if (!f || f.peppol_statut !== "livree" || f.peppol_mail_le) return;
  const email = String(f.client_email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
  const pris = await rest(`factures?id=eq.${id}&peppol_mail_le=is.null&select=id`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ peppol_mail_le: new Date().toISOString() }),
  });
  if (!pris?.length) return;
  try {
    const ent = await reglagesMail();
    let modele = MAIL_DEFAUT;
    try {
      const p = JSON.parse(ent.mail_modele_peppol || "null");
      if (p && String(p.objet || "").trim() && String(p.corps || "").trim()) modele = { objet: p.objet, corps: p.corps };
    } catch { /* texte par défaut */ }
    const { objet, html } = mailPeppol(f, modele, ent);
    await envoyerMail(email, objet, html);
  } catch (e) {
    // Échec : on libère, le suivi automatique réessaiera.
    console.error("mail Peppol", id, e);
    await rest(`factures?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ peppol_mail_le: null }) }).catch(() => {});
  }
}

// ── Envoi (une seule fois) ───────────────────────────────
async function envoyer(id: number, attendre = true, prevenirClient = true): Promise<Facture> {
  const f = await lire(id);
  if (!f || f.supprime_le) throw new ErreurClient("Facture introuvable.", 404);
  if (["livree", "en_cours", "envoi", "incertain"].includes(f.peppol_statut)) return pick(f);   // déjà parti ou en cours : on ne renvoie pas
  const nc = f.type_document === "note_credit";
  if (!f.emise_le || !f.numero) throw new ErreurClient("La facture doit être émise avant l'envoi via Peppol.");
  if (!nc && f.statut !== "payee") throw new ErreurClient("La facture part via Peppol une fois encaissée.");
  if (nc && !["imputee", "remboursee"].includes(f.statut)) throw new ErreurClient("La note de crédit part via Peppol une fois réglée (imputée ou remboursée).");
  const n = numeroBE(f.client_tva);
  if (!n) throw new ErreurClient("Numéro de TVA du client invalide : Peppol n'est possible que pour une entreprise belge.");
  const p = await surPeppol("production", n);
  if (!p.inscrit) throw new ErreurClient("Ce client n'est pas inscrit sur Peppol : envoie la facture par mail.");
  const origine = nc ? await lire(Number(f.facture_origine_id)) ?? null : null;
  const corps = construire(f, origine, await mentionTva(), p.participant!, await pdfArchive(f));
  const a = await acces("production");

  // Réservation atomique : un seul appel passe, les autres repartent avec l'état actuel.
  if ((await rpc("peppol_reserver", { p_id: id })) !== true) return pick((await lire(id))!);
  // Pack du site : le client est prévenu par le mail du Pack, pas par celui-ci.
  if (!prevenirClient) await rest(`factures?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ peppol_mail_le: new Date().toISOString() }) });

  let res: { status: number; j: Record<string, unknown> | null };
  try {
    res = await rc("production", `/${a.entreprise}/send`, { method: "POST", body: JSON.stringify(corps) });
  } catch (e) {
    return await maj(id, { peppol_statut: "incertain", peppol_destinataire: p.participant, peppol_erreur: "Connexion à Recommand interrompue pendant l'envoi : vérification en cours, ne renvoie pas." });
  }
  const j = res.j || {};
  if (j.success === true && typeof j.id === "string") {
    const e = etatDocument(j);
    let fx = await maj(id, { peppol_document_id: j.id, peppol_statut: e.statut, peppol_destinataire: p.participant, peppol_erreur: e.erreur, peppol_livree_le: e.statut === "livree" ? new Date().toISOString() : null });
    if (e.statut === "en_cours" && attendre) {
      await new Promise((r) => setTimeout(r, 4000));
      fx = await rafraichir(fx);
    } else if (e.statut === "livree") {
      await prevenir(id);
      fx = pick((await lire(id))!);
    }
    return fx;
  }
  // Refus net (contrôles, destinataire introuvable…) : rien n'est parti, nouvel essai possible.
  if (res.status < 500 && j.outcomeUnknown !== true && j.success === false) {
    return await maj(id, { peppol_statut: "echec", peppol_destinataire: p.participant, peppol_erreur: "Envoi refusé : " + raison(j) });
  }
  return await maj(id, { peppol_statut: "incertain", peppol_destinataire: p.participant, peppol_erreur: "Résultat de l'envoi inconnu (" + raison(j) + ") : vérification en cours, ne renvoie pas." });
}
const pick = (f: Facture) => Object.fromEntries(COLS.split(",").map((k) => [k, f[k] ?? null])) as Facture;

/** Met à jour une facture déjà envoyée (ou au résultat incertain) d'après Recommand. */
async function rafraichir(f: Facture): Promise<Facture> {
  const a = await acces("production");
  if (f.peppol_document_id) {
    const { status, j } = await rc("production", `/documents/${f.peppol_document_id}?excludeAttachments=true`);
    if (status !== 200 || !j?.document) return pick(f);
    const e = etatDocument(j.document);
    if (e.statut === f.peppol_statut && e.erreur === (f.peppol_erreur ?? null)) {
      if (e.statut === "livree" && !f.peppol_mail_le) { await prevenir(f.id); return pick((await lire(f.id))!); }
      return pick(f);
    }
    const fx = await maj(f.id, { peppol_statut: e.statut, peppol_erreur: e.erreur, peppol_livree_le: e.statut === "livree" ? (f.peppol_livree_le || new Date().toISOString()) : null });
    if (fx.peppol_statut === "livree") { await prevenir(f.id); return pick((await lire(f.id))!); }
    return fx;
  }
  if (!["incertain", "envoi"].includes(f.peppol_statut)) return pick(f);
  // Pas d'identifiant : on cherche le document chez Recommand par son numéro.
  const depuis = new Date(new Date(f.peppol_envoye_le || Date.now()).getTime() - 3600_000).toISOString();
  const { status, j } = await rc("production", `/documents?companyId=${a.entreprise}&direction=outgoing&search=${encodeURIComponent(f.numero)}&from=${encodeURIComponent(depuis)}&excludeAttachments=true&limit=50`);
  if (status !== 200) return pick(f);
  // deno-lint-ignore no-explicit-any
  const trouve = (j?.documents || j?.items || []).find((d: any) => [d?.parsed?.invoiceNumber, d?.parsed?.creditNoteNumber].includes(f.numero));
  if (trouve) {
    const e = etatDocument(trouve);
    const fx = await maj(f.id, { peppol_document_id: trouve.id, peppol_statut: e.statut, peppol_erreur: e.erreur, peppol_livree_le: e.statut === "livree" ? new Date().toISOString() : null });
    if (fx.peppol_statut === "livree") { await prevenir(f.id); return pick((await lire(f.id))!); }
    return fx;
  }
  // Rien chez Recommand, et l'envoi date de plus de 3 minutes : rien n'est parti.
  if (Date.now() - new Date(f.peppol_envoye_le || 0).getTime() > 180_000) {
    return await maj(f.id, { peppol_statut: "echec", peppol_erreur: "Aucun envoi trouvé chez Recommand : rien n'est parti, tu peux réessayer." });
  }
  return pick(f);
}

// ── Formulaire Pack du site : contrôle avant paiement ────
// deno-lint-ignore no-explicit-any
async function controle(c: any) {
  const n = numeroBE(c.tva);
  if (!n) return { valide: false, inscrit: false, ok: false, erreur: "Numéro de TVA invalide : vérifiez-le (format BE0123.456.789)." };
  const p = await surPeppol("production", n);
  if (!p.inscrit || !c.facture) return { valide: true, inscrit: p.inscrit, nom: p.nom, ok: true };
  // Facture à blanc avec les vraies informations : Recommand la valide sans rien envoyer.
  const a = await acces("production");
  const corps = construire(c.facture, null, await mentionTva(), p.participant!, null);
  const { status, j } = await rc("production", `/${a.entreprise}/generate`, { method: "POST", body: JSON.stringify(corps) });
  if (status === 200 && j?.success) return { valide: true, inscrit: true, nom: p.nom, ok: true };
  if (status >= 500) throw new Error("Recommand indisponible");
  return { valide: true, inscrit: true, nom: p.nom, ok: false, erreur: raison(j) };
}

Deno.serve(async (req) => {
  const o = req.headers.get("Origin");
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors(o), "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(o) });
  if (req.method !== "POST") return json({ error: "Méthode non supportée" }, 405);
  try {
    // deno-lint-ignore no-explicit-any
    const c: any = await req.json().catch(() => ({}));
    const estInterne = await interne(req);
    const estPerso = !estInterne && await personnel(req);
    const id = Number(c.facture_id);
    switch (c.action) {
      case "verifier": {
        if (!estInterne && !estPerso) return json({ error: "Non autorisé" }, 401);
        const n = numeroBE(c.tva);
        if (!n) return json({ inscrit: false, invalide: true, participant: null });
        const p = await surPeppol("production", n);
        return json({ inscrit: p.inscrit, participant: p.participant, nom: p.nom });
      }
      case "envoyer":
        if (!estInterne && !estPerso) return json({ error: "Non autorisé" }, 401);
        if (!id) throw new ErreurClient("Facture manquante.");
        // attendre:false = appel de la fonction pack, qui prévient elle-même le client.
        return json({ facture: await envoyer(id, c.attendre !== false, c.mail !== false && c.attendre !== false) });
      case "statut": {
        if (!estInterne && !estPerso) return json({ error: "Non autorisé" }, 401);
        const f = await lire(id);
        if (!f) throw new ErreurClient("Facture introuvable.", 404);
        return json({ facture: await rafraichir(f) });
      }
      case "suivre": {
        if (!estInterne) return json({ error: "Non autorisé" }, 401);
        const l = await rest(`factures?select=*&peppol_statut=in.(en_cours,envoi,incertain)&limit=50`);
        const out = [];
        for (const f of l || []) {
          // Un envoi bloqué en « envoi » depuis plus de 10 minutes devient « incertain » : on vérifie, on ne renvoie pas.
          if (f.peppol_statut === "envoi" && Date.now() - new Date(f.peppol_envoye_le || 0).getTime() > 600_000) {
            await maj(f.id, { peppol_statut: "incertain", peppol_erreur: "Envoi interrompu : vérification chez Recommand en cours." });
            f.peppol_statut = "incertain";
          }
          try { out.push(await rafraichir(f)); } catch (e) { console.error("suivi", f.id, e); }
        }
        // Mails de confirmation qui n'ont pas pu partir : nouvel essai (3 jours au plus).
        const depuis = new Date(Date.now() - 3 * 864e5).toISOString();
        const sansMail = await rest(`factures?select=id&peppol_statut=eq.livree&peppol_mail_le=is.null&client_email=not.is.null&peppol_livree_le=gt.${encodeURIComponent(depuis)}&limit=20`);
        for (const f of sansMail || []) { try { await prevenir(f.id); } catch (e) { console.error("mail", f.id, e); } }
        return json({ ok: true, suivies: out.length });
      }
      case "controle":
        if (!estInterne) return json({ error: "Non autorisé" }, 401);
        return json(await controle(c));
      case "apercu": {
        // Contrôle à blanc d'une facture réelle (rien n'est envoyé ni modifié).
        if (!estInterne) return json({ error: "Non autorisé" }, 401);
        const f = await lire(id);
        if (!f) throw new ErreurClient("Facture introuvable.", 404);
        const mode = c.mode === "test" ? "test" : "production";
        const n = numeroBE(f.client_tva);
        const origine = f.type_document === "note_credit" ? await lire(Number(f.facture_origine_id)) ?? null : null;
        const corps = construire(f, origine, await mentionTva(), `0208:${n}`, f.pdf_chemin ? await pdfArchive(f) : null);
        const a = await acces(mode);
        const { status, j } = await rc(mode, `/${a.entreprise}/generate`, { method: "POST", body: JSON.stringify(corps) });
        return json({ status, ok: j?.success === true, erreur: j?.success ? null : raison(j), xml: j?.xml ? String(j.xml).length : 0, document: corps.document && { ...corps.document as object, attachments: undefined } });
      }
      default:
        return json({ error: "Action inconnue" }, 400);
    }
  } catch (e) {
    if (e instanceof ErreurClient) return json({ error: e.message }, e.statut);
    console.error(e);
    return json({ error: e instanceof Reseau ? "Recommand injoignable, réessaie dans un instant." : (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
