// ═══════════════════════════════════════════════════════════
//  IT Soluce — Messages (boîte contact@itsoluce.be chez OVH Zimbra)
//  Edge Function Supabase : mail
//
//  Actions (POST, corps JSON { action, ... }) :
//   - synchro   : recopie les mails de la boîte OVH dans la table « mails »
//                 (Reçus, Envoyés, Indésirables, Corbeille). Lancée toutes
//                 les 5 minutes par pg_cron, ou à la demande depuis l'ERP.
//   - envoyer   : envoie un mail par le serveur SMTP d'OVH, puis en dépose
//                 une copie dans « Envoyés » de la boîte (comme une app mail).
//   - envoyer_html : même envoi pour les pages Devis, Factures et Planning,
//                 dont le message (signature comprise) est déjà mis en forme.
//   - lu        : marque un mail lu / non lu (dans l'ERP ET dans la boîte).
//   - deplacer  : vers la Corbeille, les Reçus ou les Indésirables.
//   - effacer   : suppression définitive (uniquement depuis la Corbeille).
//   - piece     : renvoie le contenu d'une pièce jointe, à la demande.
//
//  SÉCURITÉ
//   - Identifiants de la boîte : secrets Supabase OVH_MAIL_USER et
//     OVH_MAIL_PASSWORD. Jamais renvoyés, jamais écrits dans les journaux.
//   - Appel depuis l'ERP : jeton d'un utilisateur connecté, actif, ayant
//     accès à la page Messages (le propriétaire y a toujours accès).
//   - Appel par pg_cron : en-tête x-mail-jeton, comparé au jeton stocké
//     dans la table mail_jeton (illisible par les comptes de l'ERP). Ce
//     jeton ne permet QUE la synchronisation.
// ═══════════════════════════════════════════════════════════

import { Imap } from "./imap.ts";
import { Smtp } from "./smtp.ts";
import { analyserMessage, construireMessage, extrairePiece, htmlVersTexte, type Personne, type PieceJointe, toutesLesPieces } from "./mime.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HOTE = "ssl0.ovh.net";
const DOSSIERS = ["INBOX", "Sent", "Junk", "Trash"];

const SIGNATURE_DEFAUT =
  "Linton Bokolomba\nIT Soluce — Réparation informatique & électronique\n+32 474 05 66 59 · itsoluce.be";

const ORIGINES = new Set(["https://itsoluce.be", "https://www.itsoluce.be"]);
function cors(origine: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origine && ORIGINES.has(origine) ? origine : "https://itsoluce.be",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

class ErreurClient extends Error {
  constructor(msg: string, public statut = 400) { super(msg); }
}

// ── Base de données (API REST, clé de service) ──────────
async function db(chemin: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${chemin}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Base de données (${res.status}) : ${(await res.text()).slice(0, 300)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

// ── Identification ──────────────────────────────────────
async function utilisateur(req: Request): Promise<{ id: string; ecriture: boolean } | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` } });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u || typeof u.id !== "string") return null;
    const profils = await db(`profils?id=eq.${u.id}&select=role,pages,actif,lecture_seule`) as {
      role: string; pages: string[] | null; actif: boolean; lecture_seule: boolean;
    }[];
    const p = profils[0];
    if (!p || p.actif !== true) return null;
    const proprio = p.role === "proprietaire";
    if (!proprio && !(p.pages || []).includes("messages")) return null;
    return { id: u.id, ecriture: proprio || !p.lecture_seule };
  } catch {
    return null;
  }
}

function egaliteConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function jetonCronValide(req: Request): Promise<boolean> {
  const recu = req.headers.get("x-mail-jeton") ?? "";
  if (recu.length < 32) return false;
  const lignes = await db("mail_jeton?id=eq.1&select=jeton") as { jeton: string }[];
  return !!lignes[0] && egaliteConstante(recu, lignes[0].jeton);
}

// ── Boîte OVH ───────────────────────────────────────────
function identifiants() {
  const u = Deno.env.get("OVH_MAIL_USER"), p = Deno.env.get("OVH_MAIL_PASSWORD");
  if (!u || !p) throw new Error("Secrets OVH_MAIL_USER / OVH_MAIL_PASSWORD absents");
  return { utilisateur: u, motDePasse: p };
}

async function connecter(hote: string, port: number): Promise<Deno.TlsConn> {
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    Deno.connectTls({ hostname: hote, port }),
    new Promise<never>((_, rej) => {
      minuterie = setTimeout(() => rej(new Error(`Connexion à ${hote}:${port} impossible (délai)`)), 20000);
    }),
  ]).finally(() => clearTimeout(minuterie));
}

async function ouvrirImap(): Promise<Imap> {
  const { utilisateur, motDePasse } = identifiants();
  const imap = new Imap(await connecter(HOTE, 993));
  await imap.connexion(utilisateur, motDePasse);
  return imap;
}

// ── Synchronisation ─────────────────────────────────────
interface Ligne { id: number; uid: number; uidvalidity: number; lu: boolean }

const TAILLE_COMPLETE = 8_000_000;  // au-delà, seul le début du mail est lu
const TAILLE_PARTIELLE = 1_000_000;
const LOT_OCTETS = 6_000_000;       // mémoire : on télécharge par lots

async function synchroniser(imap: Imap, dossiers: string[], budget: number, dureeMax: number) {
  const debut = Date.now();
  const bilan: Record<string, { nouveaux: number; supprimes: number; restants: number; erreur?: string }> = {};

  for (const dossier of dossiers) {
    const b = { nouveaux: 0, supprimes: 0, restants: 0 } as { nouveaux: number; supprimes: number; restants: number; erreur?: string };
    bilan[dossier] = b;
    try {
      const { uidvalidity, existe } = await imap.ouvrir(dossier, true);
      const serveur = await imap.inventaire(existe);
      const d = encodeURIComponent(dossier);

      // Le serveur a renuméroté le dossier : les anciennes lignes ne valent plus rien.
      await db(`mails?dossier=eq.${d}&uidvalidity=neq.${uidvalidity}`, { method: "DELETE" });

      const locaux = await db(`mails?dossier=eq.${d}&select=id,uid,uidvalidity,lu&limit=20000`) as Ligne[];
      const connus = new Set(locaux.map((l) => l.uid));

      // Supprimés ou déplacés depuis une autre app : on les retire aussi ici.
      const partis = locaux.filter((l) => !serveur.has(l.uid)).map((l) => l.id);
      for (let i = 0; i < partis.length; i += 200) {
        await db(`mails?id=in.(${partis.slice(i, i + 200).join(",")})`, { method: "DELETE" });
      }
      b.supprimes = partis.length;

      // Lu / non lu changé ailleurs (téléphone, webmail).
      const aLire = locaux.filter((l) => serveur.has(l.uid) && serveur.get(l.uid)!.lu !== l.lu);
      for (const valeur of [true, false]) {
        const ids = aLire.filter((l) => serveur.get(l.uid)!.lu === valeur).map((l) => l.id);
        for (let i = 0; i < ids.length; i += 200) {
          await db(`mails?id=in.(${ids.slice(i, i + 200).join(",")})`, {
            method: "PATCH", body: JSON.stringify({ lu: valeur }),
          });
        }
      }

      // Nouveaux mails, les plus récents d'abord.
      const nouveaux = [...serveur.keys()].filter((u) => !connus.has(u)).sort((x, y) => y - x);
      let i = 0;
      while (i < nouveaux.length && budget > 0 && Date.now() - debut < dureeMax) {
        const lot: number[] = [];
        let octets = 0;
        const gros = serveur.get(nouveaux[i])!.taille > TAILLE_COMPLETE;
        if (gros) { lot.push(nouveaux[i++]); }
        else {
          while (i < nouveaux.length && lot.length < 10 && lot.length < budget) {
            const t = serveur.get(nouveaux[i])!.taille;
            if (t > TAILLE_COMPLETE || (lot.length && octets + t > LOT_OCTETS)) break;
            lot.push(nouveaux[i++]);
            octets += t;
          }
        }
        const recus = await imap.telecharger(lot, gros ? TAILLE_PARTIELLE : undefined);
        const lignes = [];
        for (const uid of lot) {
          const r = recus.get(uid);
          const infos = serveur.get(uid)!;
          const base = { dossier, uid, uidvalidity, lu: infos.lu, taille: infos.taille, partiel: !!r?.partiel };
          try {
            if (!r) throw new Error("absent de la réponse");
            const m = await analyserMessage(r.brut, { cle: `uid:${dossier}:${uidvalidity}:${uid}`, date: r.date });
            lignes.push({ ...base, ...m });
          } catch (e) {
            // Un mail illisible est tout de même enregistré : sinon il serait
            // retenté à chaque synchronisation, indéfiniment.
            console.error("mail illisible", dossier, uid, e instanceof Error ? e.message : e);
            lignes.push({
              ...base, fil: `uid:${dossier}:${uidvalidity}:${uid}`, objet: "(mail illisible — ouvre-le dans ton app mail)",
              extrait: "", texte: "", a: [], cc: [], pieces: [],
            });
          }
        }
        if (lignes.length) {
          await db("mails?on_conflict=dossier,uidvalidity,uid", {
            method: "POST",
            headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
            body: JSON.stringify(lignes),
          });
        }
        b.nouveaux += lignes.length;
        budget -= lot.length;
      }
      b.restants = nouveaux.length - i;
    } catch (e) {
      b.erreur = e instanceof Error ? e.message : String(e);
      console.error("synchro", dossier, b.erreur);
    }
  }
  return bilan;
}

async function noterEtat(ok: boolean, message: string, nouveaux: number) {
  await db("mail_etat?id=eq.1", {
    method: "PATCH",
    body: JSON.stringify({ derniere_synchro: new Date().toISOString(), ok, message: message.slice(0, 500), nouveaux }),
  }).catch((e) => console.error("mail_etat", e));
}

async function actionSynchro(dossiers = DOSSIERS) {
  let imap: Imap | null = null;
  try {
    imap = await ouvrirImap();
    const bilan = await synchroniser(imap, dossiers, 40, 60000);
    const erreurs = Object.entries(bilan).filter(([, b]) => b.erreur).map(([d, b]) => `${d} : ${b.erreur}`);
    const nouveaux = Object.values(bilan).reduce((a, b) => a + b.nouveaux, 0);
    const restants = Object.values(bilan).reduce((a, b) => a + b.restants, 0);
    await noterEtat(!erreurs.length, erreurs.join(" · ") || (restants ? `${restants} mails encore à importer` : "OK"), nouveaux);
    return { bilan };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await noterEtat(false, msg, 0);
    throw e;
  } finally {
    if (imap) await imap.deconnexion();
  }
}

// ── Lecture d'une ligne « mails » ───────────────────────
interface MailLigne {
  id: number; dossier: string; uid: number; uidvalidity: number; message_id: string | null;
  refs: string | null; objet: string; de_email: string | null; de_nom: string | null;
  date_mail: string | null; texte: string; a: Personne[]; cc: Personne[];
}
async function ligneMail(id: unknown): Promise<MailLigne> {
  if (!Number.isInteger(id)) throw new ErreurClient("Identifiant de mail invalide.");
  const l = await db(`mails?id=eq.${id}&select=id,dossier,uid,uidvalidity,message_id,refs,objet,de_email,de_nom,date_mail,texte,a,cc`) as MailLigne[];
  if (!l[0]) throw new ErreurClient("Ce mail n'existe plus (déplacé ou supprimé entre-temps).", 404);
  return l[0];
}

/** Ouvre le dossier du mail et vérifie qu'il n'a pas été renuméroté. */
async function ouvrirPour(imap: Imap, m: MailLigne, lecture: boolean) {
  const { uidvalidity } = await imap.ouvrir(m.dossier, lecture);
  if (uidvalidity !== Number(m.uidvalidity)) {
    throw new ErreurClient("La boîte a changé depuis la dernière synchronisation. Actualise la page.", 409);
  }
}

// ── Envoi ───────────────────────────────────────────────
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
const MAX_PIECES = 10_000_000;

function listeAdresses(v: unknown, champ: string): string[] {
  if (v === undefined || v === null || v === "") return [];
  const brut = Array.isArray(v) ? v : String(v).split(/[,;]/);
  const res = brut.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  for (const a of res) if (!EMAIL_RE.test(a)) throw new ErreurClient(`Adresse invalide (${champ}) : ${a}`);
  if (res.length > 10) throw new ErreurClient(`Trop de destinataires (${champ}, 10 maximum).`);
  return [...new Set(res)];
}

function echapper(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function paragraphes(t: string): string {
  return t.split(/\n\s*\n/).map((p) => `<p style="margin:0 0 12px">${echapper(p).replace(/\n/g, "<br>")}</p>`).join("");
}
function dateFr(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("fr-BE", { timeZone: "Europe/Brussels", dateStyle: "long", timeStyle: "short" });
}

async function reglage(cle: string): Promise<string> {
  const l = await db(`settings?cle=eq.${cle}&select=valeur`) as { valeur: string | null }[];
  return (l[0]?.valeur ?? "").trim();
}

async function actionEnvoyer(c: Record<string, unknown>) {
  const a = listeAdresses(c.a, "À");
  const cc = listeAdresses(c.cc, "Cc");
  if (!a.length) throw new ErreurClient("Indique au moins un destinataire.");
  const objet = String(c.objet ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!objet) throw new ErreurClient("L'objet est vide.");
  if (objet.length > 300) throw new ErreurClient("Objet trop long (300 caractères maximum).");
  const corps = String(c.corps ?? "").replace(/\r\n/g, "\n");
  if (corps.length > 100_000) throw new ErreurClient("Message trop long.");

  const pieces = lirePieces(c.pieces);
  let total = pieces.reduce((a, p) => a + p.contenu.length, 0);

  const reponseA = c.repondre_a_id != null ? await ligneMail(c.repondre_a_id) : null;
  const transfert = c.transfert_de_id != null ? await ligneMail(c.transfert_de_id) : null;

  const signature = (await reglage("mail_signature")) || SIGNATURE_DEFAUT;
  const nomEntreprise = (await reglage("entreprise_nom")) || "IT Soluce";
  // Texte cité : le message d'origine sous la réponse, comme une app mail.
  let citationTexte = "", citationHtml = "";
  const origine = reponseA || transfert;
  if (origine) {
    const auteur = origine.de_nom ? `${origine.de_nom} <${origine.de_email}>` : (origine.de_email || "");
    const texteOrigine = (origine.texte || "").slice(0, 20000);
    if (transfert) {
      const entete = `---------- Message transféré ----------\nDe : ${auteur}\nDate : ${dateFr(origine.date_mail)}\nObjet : ${origine.objet}\n\n`;
      citationTexte = `\n\n${entete}${texteOrigine}`;
      citationHtml = `<div style="margin-top:18px;color:#555">${paragraphes(entete + texteOrigine)}</div>`;
    } else {
      const intro = `Le ${dateFr(origine.date_mail)}, ${auteur} a écrit :`;
      citationTexte = `\n\n${intro}\n` + texteOrigine.split("\n").map((l) => "> " + l).join("\n");
      citationHtml = `<div style="margin-top:18px;color:#555">${echapper(intro)}</div>` +
        `<blockquote style="margin:6px 0 0;padding-left:12px;border-left:3px solid #ccc;color:#555">${paragraphes(texteOrigine)}</blockquote>`;
    }
  }
  if (transfert) {
    let imap: Imap | null = null;
    try {
      imap = await ouvrirImap();
      await ouvrirPour(imap, transfert, true);
      const r = (await imap.telecharger([Number(transfert.uid)])).get(Number(transfert.uid));
      if (r) for (const p of await toutesLesPieces(r.brut)) {
        total += p.contenu.length;
        if (total > MAX_PIECES) throw new ErreurClient("Les pièces jointes du mail transféré sont trop lourdes (10 Mo maximum).");
        pieces.push(p);
      }
    } finally { if (imap) await imap.deconnexion(); }
  }

  const lignesSig = signature.split("\n");
  const htmlSignature = `<div style="margin-top:16px;padding-top:10px;border-top:1px solid #e3e3e3;font-size:13px;line-height:1.55;color:#555">` +
    `<b style="color:#1d1d1f">${echapper(lignesSig[0] || "")}</b>` +
    lignesSig.slice(1).map((l) => `<br>${echapper(l)}`).join("") + `</div>`;
  const texte = `${corps}\n\n-- \n${signature}${citationTexte}\n`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1d1d1f">` +
    paragraphes(corps) + htmlSignature + citationHtml + `</div>`;

  let references: string | null = null;
  if (reponseA?.message_id) references = [reponseA.refs, reponseA.message_id].filter(Boolean).join(" ");

  return await expedier({
    nomEntreprise, a, cc, objet, texte, html, pieces,
    inReplyTo: reponseA?.message_id ?? null, references,
  });
}

/** Pièces jointes reçues de l'ERP (base64), 10 Mo au total au maximum. */
function lirePieces(v: unknown): PieceJointe[] {
  const pieces: PieceJointe[] = [];
  let total = 0;
  for (const p of (Array.isArray(v) ? v : []) as { nom?: unknown; type?: unknown; base64?: unknown }[]) {
    const b64 = String(p.base64 ?? "");
    total += Math.floor(b64.length * 3 / 4);
    if (total > MAX_PIECES) throw new ErreurClient("Pièces jointes trop lourdes (10 Mo au total maximum).");
    let octets: Uint8Array;
    try { octets = Uint8Array.from(atob(b64), (x) => x.charCodeAt(0)); }
    catch { throw new ErreurClient("Pièce jointe illisible."); }
    pieces.push({ nom: String(p.nom ?? "piece-jointe").slice(0, 200), type: String(p.type ?? "application/octet-stream"), contenu: octets });
  }
  return pieces;
}

/** Envoi SMTP par OVH, puis copie dans « Envoyés » et mise à jour de l'ERP. */
async function expedier(m: {
  nomEntreprise: string; a: string[]; cc: string[]; objet: string; texte: string; html: string;
  pieces: PieceJointe[]; inReplyTo?: string | null; references?: string | null;
}) {
  const { utilisateur, motDePasse } = identifiants();
  const messageId = `<${crypto.randomUUID()}@itsoluce.be>`;
  const brut = construireMessage({
    de: { nom: m.nomEntreprise, email: utilisateur },
    a: m.a.map((email) => ({ email })),
    cc: m.cc.map((email) => ({ email })),
    objet: m.objet, texte: m.texte, html: m.html, pieces: m.pieces, messageId,
    inReplyTo: m.inReplyTo ?? null,
    references: m.references ?? null,
  });

  await new Smtp(await connecter(HOTE, 465)).envoyer({
    utilisateur, motDePasse, de: utilisateur, destinataires: [...m.a, ...m.cc], brut,
  });

  // Copie dans « Envoyés » : le mail apparaît aussi dans ton app mail.
  let avertissement: string | null = null;
  let imap: Imap | null = null;
  try {
    imap = await ouvrirImap();
    await imap.ajouter("Sent", brut, true);
    await synchroniser(imap, ["Sent"], 5, 20000);
  } catch (e) {
    console.error("copie Envoyés", e instanceof Error ? e.message : e);
    avertissement = "Mail envoyé, mais la copie dans « Envoyés » a échoué.";
  } finally { if (imap) await imap.deconnexion(); }

  return { ok: true, message_id: messageId, avertissement };
}

/**
 * Envoi depuis les pages Devis, Factures et Planning : le message arrive déjà
 * mis en forme (HTML avec la signature « complète » de ces pages). En cas
 * d'échec, ces pages repassent d'elles-mêmes par l'ancien envoi (Resend).
 */
async function actionEnvoyerHtml(c: Record<string, unknown>) {
  const a = listeAdresses(c.a, "À");
  if (!a.length) throw new ErreurClient("Indique au moins un destinataire.");
  const objet = String(c.objet ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!objet) throw new ErreurClient("L'objet est vide.");
  if (objet.length > 300) throw new ErreurClient("Objet trop long (300 caractères maximum).");
  const html = String(c.html ?? "");
  if (!html.trim()) throw new ErreurClient("Le message est vide.");
  if (html.length > 200_000) throw new ErreurClient("Message trop long.");
  const pieces = lirePieces(c.pieces);
  const nomEntreprise = (await reglage("entreprise_nom")) || "IT Soluce";
  const corps = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#12212e">${html}</div>`;
  return await expedier({ nomEntreprise, a, cc: [], objet, texte: htmlVersTexte(html) + "\n", html: corps, pieces });
}

// ── Actions sur un mail ─────────────────────────────────
async function actionLu(c: Record<string, unknown>) {
  const m = await ligneMail(c.id);
  const lu = c.lu !== false;
  const imap = await ouvrirImap();
  try {
    await ouvrirPour(imap, m, false);
    await imap.marquerLu(Number(m.uid), lu);
  } finally { await imap.deconnexion(); }
  await db(`mails?id=eq.${m.id}`, { method: "PATCH", body: JSON.stringify({ lu }) });
  return { ok: true };
}

async function actionDeplacer(c: Record<string, unknown>) {
  const m = await ligneMail(c.id);
  const vers = String(c.vers ?? "Trash");
  if (!DOSSIERS.includes(vers) || vers === "Sent") throw new ErreurClient("Dossier de destination invalide.");
  if (vers === m.dossier) return { ok: true };
  const imap = await ouvrirImap();
  try {
    await ouvrirPour(imap, m, false);
    await imap.deplacer(Number(m.uid), vers);
    await db(`mails?id=eq.${m.id}`, { method: "DELETE" });
    await synchroniser(imap, [vers], 5, 20000);
  } finally { await imap.deconnexion(); }
  return { ok: true };
}

async function actionEffacer(c: Record<string, unknown>) {
  const m = await ligneMail(c.id);
  if (m.dossier !== "Trash") throw new ErreurClient("Seuls les mails de la Corbeille peuvent être supprimés définitivement.");
  const imap = await ouvrirImap();
  try {
    await ouvrirPour(imap, m, false);
    await imap.effacer(Number(m.uid));
  } finally { await imap.deconnexion(); }
  await db(`mails?id=eq.${m.id}`, { method: "DELETE" });
  return { ok: true };
}

async function actionPiece(c: Record<string, unknown>) {
  const m = await ligneMail(c.id);
  const index = Number(c.index);
  if (!Number.isInteger(index) || index < 0) throw new ErreurClient("Pièce jointe invalide.");
  const imap = await ouvrirImap();
  try {
    await ouvrirPour(imap, m, true);
    const r = (await imap.telecharger([Number(m.uid)])).get(Number(m.uid));
    if (!r) throw new ErreurClient("Mail introuvable dans la boîte.", 404);
    const p = await extrairePiece(r.brut, index);
    if (!p) throw new ErreurClient("Pièce jointe introuvable.", 404);
    let s = "";
    for (let i = 0; i < p.contenu.length; i += 8190) s += String.fromCharCode(...p.contenu.subarray(i, i + 8190));
    return { nom: p.nom, type: p.type, base64: btoa(s) };
  } finally { await imap.deconnexion(); }
}

// ── Point d'entrée ──────────────────────────────────────
Deno.serve(async (req) => {
  const entetes = cors(req.headers.get("Origin"));
  const json = (corps: unknown, statut = 200) =>
    new Response(JSON.stringify(corps), { status: statut, headers: { ...entetes, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: entetes });
  if (req.method !== "POST") return json({ error: "Méthode non supportée" }, 405);

  let corps: Record<string, unknown>;
  try { corps = await req.json(); } catch { return json({ error: "Requête illisible" }, 400); }
  const action = String(corps.action ?? "");

  try {
    // Tâche planifiée : synchronisation seulement.
    if (req.headers.get("x-mail-jeton") !== null) {
      if (!(await jetonCronValide(req))) return json({ error: "Jeton invalide" }, 401);
      if (action !== "synchro") return json({ error: "Action non autorisée" }, 403);
      return json(await actionSynchro());
    }

    const u = await utilisateur(req);
    if (!u) return json({ error: "Authentification requise (accès à la page Messages)." }, 401);

    if (action === "synchro") return json(await actionSynchro());
    if (action === "piece") return json(await actionPiece(corps));
    if (!u.ecriture) return json({ error: "Ton compte est en lecture seule." }, 403);
    if (action === "envoyer") return json(await actionEnvoyer(corps));
    if (action === "envoyer_html") return json(await actionEnvoyerHtml(corps));
    if (action === "lu") return json(await actionLu(corps));
    if (action === "deplacer") return json(await actionDeplacer(corps));
    if (action === "effacer") return json(await actionEffacer(corps));
    return json({ error: "Action inconnue" }, 400);
  } catch (e) {
    if (e instanceof ErreurClient) return json({ error: e.message }, e.statut);
    const msg = e instanceof Error ? e.message : String(e);
    console.error("mail", action, msg);
    return json({ error: msg }, 500);
  }
});
