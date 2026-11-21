// ═══════════════════════════════════════════════════════════
//  IT Soluce — Copie des mails automatiques dans « Envoyés »
//  Edge Function Supabase : mail-copie   (verify_jwt = false)
//
//  Les mails automatiques (facture d'un pack, confirmation de devis,
//  accusé de réception du formulaire, relances…) partent par Resend : ils
//  n'apparaissaient donc pas dans « Envoyés » de la boîte contact@itsoluce.be.
//  Après chaque envoi réussi, la fonction qui envoie appelle celle-ci, qui
//  dépose une copie du mail dans « Envoyés » (IMAP OVH). La synchronisation
//  de l'ERP (toutes les 5 minutes) le fait ensuite apparaître dans Mails.
//
//  SÉCURITÉ : appel serveur à serveur uniquement, avec la clé de service
//  (en-tête Authorization). Aucun appel public possible. Le code IMAP et
//  MIME est repris à l'identique de la fonction « mail ».
// ═══════════════════════════════════════════════════════════

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HOTE = "ssl0.ovh.net";
const enc = new TextEncoder();

// ── IMAP (repris de mail/imap.ts) ───────────────────────────
interface Flux { read(p: Uint8Array): Promise<number | null>; write(p: Uint8Array): Promise<number>; close(): void }

async function ecrireTout(flux: Flux, octets: Uint8Array): Promise<void> {
  let fait = 0;
  while (fait < octets.length) {
    const n = await flux.write(octets.subarray(fait));
    if (n <= 0) throw new Error("Écriture impossible sur la connexion");
    fait += n;
  }
}
function binaire(o: Uint8Array): string {
  let s = "";
  for (let i = 0; i < o.length; i += 8192) s += String.fromCharCode(...o.subarray(i, i + 8192));
  return s;
}
function citer(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

class Imap {
  private tampon = new Uint8Array(0);
  private numero = 0;
  constructor(private flux: Flux, private delaiMs = 30000) {}

  private async lireMorceau(): Promise<Uint8Array> {
    const morceau = new Uint8Array(65536);
    let minuterie: ReturnType<typeof setTimeout> | undefined;
    const lu = await Promise.race([
      this.flux.read(morceau),
      new Promise<never>((_, rej) => { minuterie = setTimeout(() => rej(new Error("Délai de lecture IMAP dépassé")), this.delaiMs); }),
    ]).finally(() => clearTimeout(minuterie));
    if (lu === null) throw new Error("Connexion IMAP fermée par le serveur");
    return morceau.subarray(0, lu);
  }
  private async ligne(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.tampon.length; i++) {
        if (this.tampon[i] === 13 && this.tampon[i + 1] === 10) {
          const l = binaire(this.tampon.subarray(0, i));
          this.tampon = this.tampon.subarray(i + 2);
          return l;
        }
      }
      const morceau = await this.lireMorceau();
      const neuf = new Uint8Array(this.tampon.length + morceau.length);
      neuf.set(this.tampon); neuf.set(morceau, this.tampon.length);
      this.tampon = neuf;
    }
  }
  /** Ligne de réponse ; les littéraux éventuels ({n}) sont lus et ignorés. */
  private async reponse(): Promise<string> {
    const l = await this.ligne();
    const m = l.match(/\{(\d+)\+?\}$/);
    if (!m) return l;
    let reste = Number(m[1]);
    while (reste > 0) {
      if (!this.tampon.length) this.tampon = (await this.lireMorceau()).slice();
      const pris = Math.min(reste, this.tampon.length);
      this.tampon = this.tampon.subarray(pris); reste -= pris;
    }
    return l + " " + (await this.reponse());
  }
  async accueil(): Promise<void> {
    const t = await this.reponse();
    if (!t.startsWith("* OK") && !t.startsWith("* PREAUTH")) throw new Error("Accueil IMAP inattendu");
  }
  async commande(cmd: string, litteral?: Uint8Array): Promise<void> {
    const tag = "c" + (++this.numero);
    await ecrireTout(this.flux, enc.encode(litteral ? `${tag} ${cmd} {${litteral.length}}\r\n` : `${tag} ${cmd}\r\n`));
    for (;;) {
      const debut = await this.reponse();
      if (debut.startsWith("+")) {
        if (!litteral) throw new Error("Continuation IMAP inattendue");
        await ecrireTout(this.flux, litteral);
        await ecrireTout(this.flux, enc.encode("\r\n"));
        litteral = undefined;
        continue;
      }
      if (debut.startsWith(tag + " ")) {
        const etat = debut.slice(tag.length + 1);
        if (!etat.startsWith("OK")) throw new Error(`IMAP ${cmd.split(" ")[0]} refusée : ${etat.slice(0, 200)}`);
        return;
      }
    }
  }
  async connexion(u: string, p: string): Promise<void> { await this.accueil(); await this.commande(`LOGIN ${citer(u)} ${citer(p)}`); }
  async ajouter(dossier: string, brut: Uint8Array): Promise<void> { await this.commande(`APPEND ${citer(dossier)} (\\Seen)`, brut); }
  async deconnexion(): Promise<void> {
    try { await this.commande("LOGOUT"); } catch { /* le serveur ferme parfois avant de répondre */ }
    try { this.flux.close(); } catch { /* déjà fermée */ }
  }
}

async function connecter(hote: string, port: number): Promise<Deno.TlsConn> {
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    Deno.connectTls({ hostname: hote, port }),
    new Promise<never>((_, rej) => { minuterie = setTimeout(() => rej(new Error(`Connexion à ${hote}:${port} impossible (délai)`)), 20000); }),
  ]).finally(() => clearTimeout(minuterie));
}

// ── MIME (repris de mail/mime.ts) ───────────────────────────
interface Personne { nom?: string; email: string }
interface PieceJointe { nom: string; type: string; contenu: Uint8Array }

function base64(o: Uint8Array): string {
  let s = "";
  for (let i = 0; i < o.length; i += 8190) s += String.fromCharCode(...o.subarray(i, i + 8190));
  return btoa(s);
}
function base64Lignes(o: Uint8Array): string {
  const b = base64(o); const l: string[] = [];
  for (let i = 0; i < b.length; i += 76) l.push(b.slice(i, i + 76));
  return l.join("\r\n");
}
function encoderEntete(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const mots: string[] = []; let courant = "";
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
function paramNom(cle: string, nom: string): string {
  const propre = nom.replace(/[\r\n"\\]/g, "_");
  if (/^[\x20-\x7e]*$/.test(propre)) return `${cle}="${propre}"`;
  return `${cle}*=UTF-8''${encodeURIComponent(propre)}`;
}
function htmlVersTexte(html: string): string {
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
function construireMessage(m: { de: Personne; a: Personne[]; objet: string; texte: string; html: string; pieces: PieceJointe[]; messageId: string }): Uint8Array {
  const alea = () => crypto.randomUUID().replace(/-/g, "");
  const bMixte = "=_mixte_" + alea(), bAlt = "=_alt_" + alea();
  const l: string[] = [];
  l.push(`From: ${adresse(m.de)}`);
  l.push(`To: ${m.a.map(adresse).join(", ")}`);
  l.push(`Subject: ${encoderEntete(m.objet)}`);
  l.push(`Date: ${dateRfc(new Date())}`);
  l.push(`Message-ID: ${m.messageId}`);
  l.push("MIME-Version: 1.0");
  const alternative = [
    `Content-Type: multipart/alternative; boundary="${bAlt}"`, "",
    `--${bAlt}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", base64Lignes(enc.encode(m.texte)),
    `--${bAlt}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", base64Lignes(enc.encode(m.html)),
    `--${bAlt}--`,
  ];
  if (!m.pieces.length) l.push(...alternative);
  else {
    l.push(`Content-Type: multipart/mixed; boundary="${bMixte}"`, "", `--${bMixte}`, ...alternative);
    for (const p of m.pieces) {
      const type = /^[\w.+-]+\/[\w.+-]+$/.test(p.type) ? p.type : "application/octet-stream";
      l.push(`--${bMixte}`, `Content-Type: ${type}; ${paramNom("name", p.nom)}`, "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; ${paramNom("filename", p.nom)}`, "", base64Lignes(p.contenu));
    }
    l.push(`--${bMixte}--`);
  }
  l.push("");
  return enc.encode(l.join("\r\n"));
}

// Jeton interne de la synchronisation de la boîte (table mail_jeton, lisible
// seulement avec la clé de service) : permet aussi un test depuis la base.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
async function jetonInterneValide(req: Request): Promise<boolean> {
  const recu = req.headers.get("x-mail-jeton") ?? "";
  if (recu.length < 32) return false;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/mail_jeton?id=eq.1&select=jeton`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!r.ok) return false;
  const l = await r.json();
  const attendu = String(l?.[0]?.jeton ?? "");
  if (!attendu || attendu.length !== recu.length) return false;
  let d = 0;
  for (let i = 0; i < recu.length; i++) d |= recu.charCodeAt(i) ^ attendu.charCodeAt(i);
  return d === 0;
}

// ── Point d'entrée ─────────────────────────────────────────
Deno.serve(async (req) => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: "Méthode non supportée" }, 405);
  const jeton = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!(jeton && jeton === SERVICE_KEY) && !(await jetonInterneValide(req))) return json({ error: "Non autorisé" }, 401);

  let imap: Imap | null = null;
  try {
    const c = await req.json();
    const a = (Array.isArray(c.a) ? c.a : [c.a]).map((x: unknown) => String(x ?? "").trim()).filter((x: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 10);
    if (!a.length) return json({ error: "Destinataire manquant" }, 400);
    const html = String(c.html ?? "").slice(0, 2_000_000);
    const objet = String(c.objet ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
    const pieces: PieceJointe[] = (Array.isArray(c.pieces) ? c.pieces : []).slice(0, 5).map((p: Record<string, unknown>) => ({
      nom: String(p.nom ?? "piece-jointe").slice(0, 150),
      type: String(p.type ?? "application/pdf"),
      contenu: Uint8Array.from(atob(String(p.base64 ?? "")), (ch) => ch.charCodeAt(0)),
    }));
    const u = Deno.env.get("OVH_MAIL_USER"), mdp = Deno.env.get("OVH_MAIL_PASSWORD");
    if (!u || !mdp) throw new Error("Secrets OVH_MAIL_USER / OVH_MAIL_PASSWORD absents");
    const brut = construireMessage({
      de: { nom: String(c.de_nom ?? "IT Soluce").slice(0, 80), email: u },
      a: a.map((email: string) => ({ email })), objet, texte: htmlVersTexte(html), html, pieces,
      messageId: `<${crypto.randomUUID()}@itsoluce.be>`,
    });
    imap = new Imap(await connecter(HOTE, 993));
    await imap.connexion(u, mdp);
    await imap.ajouter("Sent", brut);
    return json({ ok: true });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error("mail-copie", m);
    return json({ error: m }, 500);
  } finally { if (imap) await imap.deconnexion(); }
});
