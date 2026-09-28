// ═══════════════════════════════════════════════════════════
//  Client SMTP minimal (RFC 5321) — envoi par ssl0.ovh.net:465 (SSL).
//  Le mail part de la vraie boîte contact@itsoluce.be, comme depuis
//  l'app mail : même serveur, mêmes enregistrements SPF/DKIM.
// ═══════════════════════════════════════════════════════════

import type { Flux } from "./imap.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ErreurSmtp extends Error {}

export class Smtp {
  private tampon = "";
  constructor(private flux: Flux, private delaiMs = 30000) {}

  /** Une réponse complète (éventuellement sur plusieurs lignes « 250-… »). */
  private async reponse(): Promise<{ code: number; texte: string }> {
    const lignes: string[] = [];
    for (;;) {
      let i: number;
      while ((i = this.tampon.indexOf("\r\n")) < 0) {
        const morceau = new Uint8Array(8192);
        let minuterie: ReturnType<typeof setTimeout> | undefined;
        const lu = await Promise.race([
          this.flux.read(morceau),
          new Promise<never>((_, rej) => {
            minuterie = setTimeout(() => rej(new ErreurSmtp("Délai SMTP dépassé")), this.delaiMs);
          }),
        ]).finally(() => clearTimeout(minuterie));
        if (lu === null) throw new ErreurSmtp("Connexion SMTP fermée par le serveur");
        this.tampon += dec.decode(morceau.subarray(0, lu));
      }
      const l = this.tampon.slice(0, i);
      this.tampon = this.tampon.slice(i + 2);
      lignes.push(l);
      if (/^\d{3} /.test(l) || /^\d{3}$/.test(l)) {
        return { code: Number(l.slice(0, 3)), texte: lignes.join("\n") };
      }
    }
  }

  private async attendre(attendu: number[], etape: string) {
    const r = await this.reponse();
    if (!attendu.includes(r.code)) {
      throw new ErreurSmtp(`SMTP ${etape} refusé (${r.code}) : ${r.texte.slice(0, 200)}`);
    }
    return r;
  }

  private async envoyerLigne(l: string) {
    await this.flux.write(enc.encode(l + "\r\n"));
  }

  async envoyer(opts: {
    utilisateur: string;
    motDePasse: string;
    de: string;
    destinataires: string[];
    brut: Uint8Array;
  }): Promise<void> {
    try {
      await this.attendre([220], "accueil");
      await this.envoyerLigne("EHLO itsoluce.be");
      await this.attendre([250], "EHLO");
      const jeton = btoa(String.fromCharCode(...enc.encode(`\u0000${opts.utilisateur}\u0000${opts.motDePasse}`)));
      await this.envoyerLigne(`AUTH PLAIN ${jeton}`);
      await this.attendre([235], "identification");
      await this.envoyerLigne(`MAIL FROM:<${opts.de}>`);
      await this.attendre([250], "expéditeur");
      for (const d of opts.destinataires) {
        await this.envoyerLigne(`RCPT TO:<${d}>`);
        await this.attendre([250, 251], `destinataire ${d}`);
      }
      await this.envoyerLigne("DATA");
      await this.attendre([354], "DATA");
      await this.flux.write(pointsDoubles(opts.brut));
      await this.flux.write(enc.encode("\r\n.\r\n"));
      await this.attendre([250], "envoi");
      await this.envoyerLigne("QUIT");
      await this.reponse().catch(() => {});
    } finally {
      try { this.flux.close(); } catch { /* déjà fermée */ }
    }
  }
}

/**
 * « Dot-stuffing » : une ligne du message qui commence par un point
 * serait prise pour la fin du message ; on la double.
 */
export function pointsDoubles(brut: Uint8Array): Uint8Array {
  // Cas courant : aucune ligne ne commence par un point, rien à copier.
  let aTraiter = brut[0] === 46;
  for (let i = 0; !aTraiter && i + 1 < brut.length; i++) {
    if (brut[i] === 10 && brut[i + 1] === 46) aTraiter = true;
  }
  if (!aTraiter) return brut;
  const sortie: number[] = [];
  let debutLigne = true;
  for (let i = 0; i < brut.length; i++) {
    const c = brut[i];
    if (debutLigne && c === 46) sortie.push(46);
    sortie.push(c);
    debutLigne = c === 10;
  }
  return Uint8Array.from(sortie);
}
