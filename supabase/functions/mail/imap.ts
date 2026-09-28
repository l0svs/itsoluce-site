// ═══════════════════════════════════════════════════════════
//  Client IMAP minimal (RFC 3501) pour la boîte OVH Zimbra.
//
//  Travaille au niveau des octets : le contenu d'un mail est renvoyé
//  par le serveur sous forme de « littéral » ({n} suivi de n octets bruts),
//  qui peut contenir n'importe quel jeu de caractères. Le décoder en texte
//  trop tôt abîmerait les accents des mails qui ne sont pas en UTF-8 ; il
//  est donc gardé en octets jusqu'à l'analyse MIME.
// ═══════════════════════════════════════════════════════════

export interface Flux {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

// Élément d'une réponse analysée : texte (atome ou chaîne), octets
// (littéral), liste entre parenthèses, ou NIL (null).
export type Jeton = string | Uint8Array | null | Jeton[];

const enc = new TextEncoder();

/** Octets → chaîne « binaire » (1 caractère = 1 octet). */
function binaire(o: Uint8Array): string {
  let s = "";
  for (let i = 0; i < o.length; i += 8192) {
    s += String.fromCharCode(...o.subarray(i, i + 8192));
  }
  return s;
}

/** Chaîne IMAP entre guillemets. */
export function citer(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Réponse logique : la ligne (sans les littéraux) et les littéraux, dans l'ordre. */
interface Reponse {
  morceaux: (string | Uint8Array)[];
}

export class ErreurImap extends Error {}

export class Imap {
  private tampon = new Uint8Array(0);
  private numero = 0;
  capacites = new Set<string>();

  constructor(private flux: Flux, private delaiMs = 30000) {}

  // ── Lecture bas niveau ───────────────────────────────────
  private async lireMorceau(): Promise<Uint8Array> {
    const morceau = new Uint8Array(65536);
    let minuterie: ReturnType<typeof setTimeout> | undefined;
    const lu = await Promise.race([
      this.flux.read(morceau),
      new Promise<never>((_, rej) => {
        minuterie = setTimeout(() => rej(new ErreurImap("Délai de lecture IMAP dépassé")), this.delaiMs);
      }),
    ]).finally(() => clearTimeout(minuterie));
    if (lu === null) throw new ErreurImap("Connexion IMAP fermée par le serveur");
    return morceau.subarray(0, lu);
  }

  private async remplir(): Promise<void> {
    const morceau = await this.lireMorceau();
    const neuf = new Uint8Array(this.tampon.length + morceau.length);
    neuf.set(this.tampon);
    neuf.set(morceau, this.tampon.length);
    this.tampon = neuf;
  }

  /** Une ligne terminée par CRLF, sans le CRLF, en chaîne binaire. */
  private async ligne(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.tampon.length; i++) {
        if (this.tampon[i] === 13 && this.tampon[i + 1] === 10) {
          const l = binaire(this.tampon.subarray(0, i));
          this.tampon = this.tampon.subarray(i + 2);
          return l;
        }
      }
      await this.remplir();
    }
  }

  /** n octets bruts (littéral). Copiés une seule fois, même pour un gros mail. */
  private async octets(n: number): Promise<Uint8Array> {
    const res = new Uint8Array(n);
    let fait = Math.min(n, this.tampon.length);
    res.set(this.tampon.subarray(0, fait));
    this.tampon = this.tampon.subarray(fait);
    while (fait < n) {
      const morceau = await this.lireMorceau();
      const utile = Math.min(morceau.length, n - fait);
      res.set(morceau.subarray(0, utile), fait);
      fait += utile;
      if (morceau.length > utile) this.tampon = morceau.slice(utile);
    }
    return res;
  }

  /** Une réponse complète : une ligne, plus ses éventuels littéraux. */
  private async reponse(): Promise<Reponse> {
    const morceaux: (string | Uint8Array)[] = [];
    for (;;) {
      const l = await this.ligne();
      const m = l.match(/\{(\d+)\+?\}$/);
      if (!m) {
        morceaux.push(l);
        return { morceaux };
      }
      morceaux.push(l.slice(0, l.length - m[0].length));
      morceaux.push(await this.octets(Number(m[1])));
    }
  }

  // ── Commandes ────────────────────────────────────────────
  async accueil(): Promise<void> {
    const r = await this.reponse();
    const t = String(r.morceaux[0]);
    if (!t.startsWith("* OK") && !t.startsWith("* PREAUTH")) {
      throw new ErreurImap("Accueil IMAP inattendu");
    }
  }

  /**
   * Envoie une commande et renvoie ses réponses non étiquetées, analysées.
   * `litteral` : octets envoyés après la demande de continuation « + »
   * (utilisé par APPEND).
   */
  async commande(cmd: string, litteral?: Uint8Array): Promise<Jeton[][]> {
    const tag = "m" + (++this.numero);
    if (litteral) {
      await this.flux.write(enc.encode(`${tag} ${cmd} {${litteral.length}}\r\n`));
    } else {
      await this.flux.write(enc.encode(`${tag} ${cmd}\r\n`));
    }
    const nonEtiquetees: Jeton[][] = [];
    for (;;) {
      const r = await this.reponse();
      const debut = String(r.morceaux[0]);
      if (debut.startsWith("+")) {
        if (!litteral) throw new ErreurImap("Continuation IMAP inattendue");
        await this.flux.write(litteral);
        await this.flux.write(enc.encode("\r\n"));
        litteral = undefined;
        continue;
      }
      if (debut.startsWith(tag + " ")) {
        const etat = debut.slice(tag.length + 1);
        if (!etat.startsWith("OK")) {
          // Le texte du serveur ne contient jamais le mot de passe : LOGIN
          // renvoie seulement « NO LOGIN failed ».
          throw new ErreurImap(`IMAP ${cmd.split(" ")[0]} refusée : ${etat.slice(0, 200)}`);
        }
        this.derniereReponseOk = etat;
        return nonEtiquetees;
      }
      nonEtiquetees.push(analyser(r));
    }
  }

  derniereReponseOk = "";

  async connexion(utilisateur: string, motDePasse: string): Promise<void> {
    await this.accueil();
    await this.commande(`LOGIN ${citer(utilisateur)} ${citer(motDePasse)}`);
    const caps = await this.commande("CAPABILITY");
    for (const r of caps) {
      if (r[1] === "CAPABILITY") {
        for (const c of r.slice(2)) if (typeof c === "string") this.capacites.add(c.toUpperCase());
      }
    }
  }

  /** Ouvre un dossier. `lecture` = EXAMINE (aucune modification possible). */
  async ouvrir(dossier: string, lecture: boolean): Promise<{ uidvalidity: number; existe: number }> {
    const rep = await this.commande(`${lecture ? "EXAMINE" : "SELECT"} ${citer(dossier)}`);
    let uidvalidity = 0, existe = 0;
    for (const r of rep) {
      if (r[2] === "EXISTS") existe = Number(r[1]);
      const code = r[2];
      if (r[1] === "OK" && Array.isArray(code) && code[0] === "UIDVALIDITY") uidvalidity = Number(code[1]);
      // Certains serveurs écrivent « [UIDVALIDITY 123] » comme un seul atome.
      if (r[1] === "OK" && typeof code === "string") {
        const m = code.match(/^\[UIDVALIDITY (\d+)\]$/);
        if (m) uidvalidity = Number(m[1]);
      }
    }
    return { uidvalidity, existe };
  }

  /** UID, drapeaux et taille de tous les messages du dossier ouvert. */
  async inventaire(existe: number): Promise<Map<number, { lu: boolean; taille: number }>> {
    const res = new Map<number, { lu: boolean; taille: number }>();
    if (existe <= 0) return res;
    const rep = await this.commande("FETCH 1:* (UID FLAGS RFC822.SIZE)");
    for (const r of rep) {
      if (r[2] !== "FETCH" || !Array.isArray(r[3])) continue;
      const a = attributs(r[3]);
      const uid = Number(a.get("UID"));
      if (!uid) continue;
      const flags = a.get("FLAGS");
      const lu = Array.isArray(flags) && flags.some((f) => typeof f === "string" && f.toLowerCase() === "\\seen");
      res.set(uid, { lu, taille: Number(a.get("RFC822.SIZE")) || 0 });
    }
    return res;
  }

  /**
   * Contenu brut de messages, par UID. `limite` : au-delà de cette taille,
   * seul le début du message est téléchargé (partiel = true).
   */
  async telecharger(
    uids: number[],
    limite?: number,
  ): Promise<Map<number, { brut: Uint8Array; date: string | null; partiel: boolean }>> {
    const res = new Map<number, { brut: Uint8Array; date: string | null; partiel: boolean }>();
    if (!uids.length) return res;
    const corps = limite ? `BODY.PEEK[]<0.${limite}>` : "BODY.PEEK[]";
    const rep = await this.commande(`UID FETCH ${uids.join(",")} (UID INTERNALDATE ${corps})`);
    for (const r of rep) {
      if (r[2] !== "FETCH" || !Array.isArray(r[3])) continue;
      const a = attributs(r[3]);
      const uid = Number(a.get("UID"));
      let brut: Jeton | undefined;
      for (const [k, v] of a) if (k.startsWith("BODY[]")) brut = v;
      if (!uid || brut === undefined) continue;
      const octets = brut instanceof Uint8Array ? brut : enc.encode(typeof brut === "string" ? brut : "");
      const date = a.get("INTERNALDATE");
      res.set(uid, { brut: octets, date: typeof date === "string" ? date : null, partiel: !!limite });
    }
    return res;
  }

  async marquerLu(uid: number, lu: boolean): Promise<void> {
    await this.commande(`UID STORE ${uid} ${lu ? "+" : "-"}FLAGS.SILENT (\\Seen)`);
  }

  /** Déplace un message du dossier ouvert (en SELECT) vers un autre dossier. */
  async deplacer(uid: number, vers: string): Promise<void> {
    if (this.capacites.has("MOVE")) {
      await this.commande(`UID MOVE ${uid} ${citer(vers)}`);
      return;
    }
    await this.commande(`UID COPY ${uid} ${citer(vers)}`);
    await this.commande(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
    if (this.capacites.has("UIDPLUS")) await this.commande(`UID EXPUNGE ${uid}`);
    else await this.commande("EXPUNGE");
  }

  /** Supprime définitivement un message du dossier ouvert (en SELECT). */
  async effacer(uid: number): Promise<void> {
    await this.commande(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
    if (this.capacites.has("UIDPLUS")) await this.commande(`UID EXPUNGE ${uid}`);
    else await this.commande("EXPUNGE");
  }

  async ajouter(dossier: string, brut: Uint8Array, lu: boolean): Promise<void> {
    await this.commande(`APPEND ${citer(dossier)} (${lu ? "\\Seen" : ""})`, brut);
  }

  async deconnexion(): Promise<void> {
    try { await this.commande("LOGOUT"); } catch { /* le serveur ferme parfois avant de répondre */ }
    try { this.flux.close(); } catch { /* déjà fermée */ }
  }
}

/** Paires clé/valeur d'une liste d'attributs FETCH : (UID 12 FLAGS (...) ...). */
export function attributs(liste: Jeton[]): Map<string, Jeton> {
  const m = new Map<string, Jeton>();
  for (let i = 0; i + 1 < liste.length; i += 2) {
    const k = liste[i];
    if (typeof k === "string") m.set(k.toUpperCase(), liste[i + 1]);
  }
  return m;
}

/** Analyse une réponse (ligne + littéraux) en jetons imbriqués. */
export function analyser(r: Reponse): Jeton[] {
  const racine: Jeton[] = [];
  const pile: Jeton[][] = [racine];
  const courant = () => pile[pile.length - 1];

  for (const morceau of r.morceaux) {
    if (morceau instanceof Uint8Array) {
      courant().push(morceau);
      continue;
    }
    const s = morceau;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === " ") { i++; continue; }
      if (c === "(") { const l: Jeton[] = []; courant().push(l); pile.push(l); i++; continue; }
      if (c === ")") { if (pile.length > 1) pile.pop(); i++; continue; }
      if (c === '"') {
        let v = "";
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === "\\" && i + 1 < s.length) i++;
          v += s[i++];
        }
        i++;
        courant().push(v);
        continue;
      }
      // Atome. Un « [ » ouvre une section (BODY[HEADER.FIELDS (A B)]<0>) qui
      // peut contenir espaces et parenthèses : on la garde d'un seul tenant.
      let v = "";
      let crochets = 0;
      while (i < s.length) {
        const d = s[i];
        if (d === "[") crochets++;
        else if (d === "]") crochets = Math.max(0, crochets - 1);
        else if (crochets === 0 && (d === " " || d === "(" || d === ")")) break;
        v += d;
        i++;
      }
      courant().push(v === "NIL" ? null : v);
    }
  }
  return racine;
}
