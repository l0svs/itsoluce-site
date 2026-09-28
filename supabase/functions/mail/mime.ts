// ═══════════════════════════════════════════════════════════
//  Construction (envoi) et lecture (réception) des mails au format MIME.
// ═══════════════════════════════════════════════════════════

import PostalMime from "npm:postal-mime@2.7.6";

const enc = new TextEncoder();

export interface Personne { nom?: string; email: string }
export interface PieceJointe { nom: string; type: string; contenu: Uint8Array }

// ── Encodage ──────────────────────────────────────────────

function base64(o: Uint8Array): string {
  let s = "";
  for (let i = 0; i < o.length; i += 8190) s += String.fromCharCode(...o.subarray(i, i + 8190));
  return btoa(s);
}

/** Base64 découpé en lignes de 76 caractères (limite MIME). */
function base64Lignes(o: Uint8Array): string {
  const b = base64(o);
  const lignes: string[] = [];
  for (let i = 0; i < b.length; i += 76) lignes.push(b.slice(i, i + 76));
  return lignes.join("\r\n");
}

/** En-tête avec accents : « mots encodés » RFC 2047, sans couper un caractère. */
export function encoderEntete(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const mots: string[] = [];
  let courant = "";
  for (const c of s) {
    if (enc.encode(courant + c).length > 42) { mots.push(courant); courant = ""; }
    courant += c;
  }
  if (courant) mots.push(courant);
  return mots.map((m) => `=?UTF-8?B?${base64(enc.encode(m))}?=`).join("\r\n ");
}

function adresse(p: Personne): string {
  if (!p.nom) return `<${p.email}>`;
  const nom = /^[\x20-\x7e]*$/.test(p.nom) ? `"${p.nom.replace(/["\\]/g, "")}"` : encoderEntete(p.nom);
  return `${nom} <${p.email}>`;
}

function dateRfc(d: Date): string {
  const j = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${j}, ${d.getUTCDate()} ${m} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** Nom de fichier d'une pièce jointe (RFC 2231 si accents). */
function paramNom(cle: string, nom: string): string {
  const propre = nom.replace(/[\r\n"\\]/g, "_");
  if (/^[\x20-\x7e]*$/.test(propre)) return `${cle}="${propre}"`;
  return `${cle}*=UTF-8''${encodeURIComponent(propre)}`;
}

export function construireMessage(m: {
  de: Personne;
  a: Personne[];
  cc: Personne[];
  objet: string;
  texte: string;
  html: string;
  pieces: PieceJointe[];
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  date?: Date;
}): Uint8Array {
  const alea = () => crypto.randomUUID().replace(/-/g, "");
  const bMixte = "=_mixte_" + alea();
  const bAlt = "=_alt_" + alea();
  const l: string[] = [];
  l.push(`From: ${adresse(m.de)}`);
  l.push(`To: ${m.a.map(adresse).join(", ")}`);
  if (m.cc.length) l.push(`Cc: ${m.cc.map(adresse).join(", ")}`);
  l.push(`Subject: ${encoderEntete(m.objet)}`);
  l.push(`Date: ${dateRfc(m.date ?? new Date())}`);
  l.push(`Message-ID: ${m.messageId}`);
  if (m.inReplyTo) l.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.references) l.push(`References: ${m.references}`);
  l.push("MIME-Version: 1.0");

  const alternative = [
    `Content-Type: multipart/alternative; boundary="${bAlt}"`,
    "",
    `--${bAlt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lignes(enc.encode(m.texte)),
    `--${bAlt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lignes(enc.encode(m.html)),
    `--${bAlt}--`,
  ];

  if (!m.pieces.length) {
    l.push(...alternative);
  } else {
    l.push(`Content-Type: multipart/mixed; boundary="${bMixte}"`, "", `--${bMixte}`, ...alternative);
    for (const p of m.pieces) {
      const type = /^[\w.+-]+\/[\w.+-]+$/.test(p.type) ? p.type : "application/octet-stream";
      l.push(
        `--${bMixte}`,
        `Content-Type: ${type}; ${paramNom("name", p.nom)}`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; ${paramNom("filename", p.nom)}`,
        "",
        base64Lignes(p.contenu),
      );
    }
    l.push(`--${bMixte}--`);
  }
  l.push("");
  return enc.encode(l.join("\r\n"));
}

// ── Lecture ───────────────────────────────────────────────

const MAX_HTML = 400_000;
const MAX_TEXTE = 100_000;

function versPersonnes(liste: unknown): Personne[] {
  const res: Personne[] = [];
  const ajouter = (x: { name?: string; address?: string; group?: unknown[] }) => {
    if (x.group) { for (const g of x.group) ajouter(g as typeof x); return; }
    if (x.address) res.push({ nom: x.name || "", email: x.address.toLowerCase() });
  };
  if (Array.isArray(liste)) for (const x of liste) ajouter(x);
  else if (liste && typeof liste === "object") ajouter(liste as { address?: string });
  return res;
}

/** Image intégrée au corps (logo de signature…) : ce n'est pas une pièce jointe. */
function estImageIntegree(p: { disposition: string | null; contentId?: string; mimeType: string }): boolean {
  return !!p.contentId && p.disposition !== "attachment" && /^image\//i.test(p.mimeType || "");
}

/** Texte brut tiré d'un HTML, pour l'aperçu et la recherche. */
export function htmlVersTexte(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function premierId(s: string | undefined | null): string | null {
  const m = String(s ?? "").match(/<[^<>\s]+>/);
  return m ? m[0] : null;
}

export interface MailAnalyse {
  message_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  fil: string;
  de_email: string | null;
  de_nom: string | null;
  repondre_a: string | null;
  a: Personne[];
  cc: Personne[];
  objet: string;
  date_mail: string | null;
  extrait: string;
  texte: string;
  html: string | null;
  pieces: { index: number; nom: string; type: string; taille: number }[];
}

export async function analyserMessage(brut: Uint8Array, repli: { cle: string; date: string | null }): Promise<MailAnalyse> {
  const e = await PostalMime.parse(brut);
  const de = versPersonnes(e.from)[0];
  const messageId = premierId(e.messageId);
  const inReplyTo = premierId(e.inReplyTo);
  const refs = (String(e.references ?? "").match(/<[^<>\s]+>/g) || []).join(" ") || null;
  // Fil de discussion : le premier message de la chaîne (en tête des
  // References), sinon celui auquel on répond, sinon le message lui-même.
  const fil = (refs ? refs.split(" ")[0] : null) || inReplyTo || messageId || repli.cle;

  let html = e.html ? String(e.html) : null;
  let texte = e.text ? String(e.text) : "";
  if (!texte && html) texte = htmlVersTexte(html);
  if (html && html.length > MAX_HTML) html = null; // trop lourd : le texte suffit
  if (texte.length > MAX_TEXTE) texte = texte.slice(0, MAX_TEXTE) + "\n[…]";

  const pieces = (e.attachments || [])
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => !estImageIntegree(p))
    .map(({ p, index }) => ({
      index,
      nom: p.filename || "piece-jointe",
      type: p.mimeType || "application/octet-stream",
      taille: typeof p.content === "string" ? p.content.length : (p.content as ArrayBuffer).byteLength,
    }));

  let dateMail: string | null = null;
  const d = e.date ? new Date(e.date) : repli.date ? new Date(repli.date) : null;
  if (d && !isNaN(d.getTime())) dateMail = d.toISOString();

  return {
    message_id: messageId,
    in_reply_to: inReplyTo,
    refs,
    fil,
    de_email: de?.email ?? null,
    de_nom: de?.nom || null,
    repondre_a: versPersonnes(e.replyTo)[0]?.email ?? null,
    a: versPersonnes(e.to),
    cc: versPersonnes(e.cc),
    objet: (e.subject || "").slice(0, 500),
    date_mail: dateMail,
    extrait: texte.replace(/\s+/g, " ").trim().slice(0, 220),
    texte,
    html,
    pieces,
  };
}

/** Contenu d'une pièce jointe (index = position dans la liste complète). */
export async function extrairePiece(brut: Uint8Array, index: number): Promise<PieceJointe | null> {
  const e = await PostalMime.parse(brut);
  const p = (e.attachments || [])[index];
  if (!p) return null;
  const contenu = typeof p.content === "string" ? enc.encode(p.content) : new Uint8Array(p.content as ArrayBuffer);
  return { nom: p.filename || "piece-jointe", type: p.mimeType || "application/octet-stream", contenu };
}

/** Toutes les pièces jointes (pour un transfert). */
export async function toutesLesPieces(brut: Uint8Array): Promise<PieceJointe[]> {
  const e = await PostalMime.parse(brut);
  return (e.attachments || [])
    .filter((p) => !estImageIntegree(p))
    .map((p) => ({
      nom: p.filename || "piece-jointe",
      type: p.mimeType || "application/octet-stream",
      contenu: typeof p.content === "string" ? enc.encode(p.content) : new Uint8Array(p.content as ArrayBuffer),
    }));
}
