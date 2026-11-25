// ═══════════════════════════════════════════════════════════
//  IT Soluce — Rappel automatique des rendez-vous (24 h avant)
//  Edge Function Supabase : rappel-rdv
//
//  Appelée toutes les 15 minutes par pg_cron (jeton de la table sync_jeton,
//  comme la synchronisation Foneday). Elle envoie un rappel par e-mail pour
//  chaque rendez-vous qui commence dans les 24 prochaines heures, si :
//    - le rappel automatique est activé sur le rendez-vous (rappel_auto) ;
//    - aucun rappel n'a encore été envoyé (rappel_envoye_le vide) ;
//    - le client a une adresse e-mail ;
//    - le rendez-vous n'est ni terminé ni supprimé.
//  Le rendez-vous est « réservé » (rappel_envoye_le rempli) avant l'envoi :
//  deux appels simultanés ne peuvent pas envoyer deux fois le même rappel.
//  Si l'envoi échoue, la réservation est annulée : le prochain passage réessaie.
//
//  Texte : réglage mail_modele_rappel_rdv (Gestion › Mails), sinon le texte
//  par défaut ci-dessous — à garder identique à admin/assets/js/mail-modeles.js.
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EXPEDITEUR = "contact@itsoluce.be";
const FUSEAU = "Europe/Brussels";

const MODELE_DEFAUT = {
  objet: "Rappel : votre rendez-vous du {date_rdv}",
  corps: "Bonjour {prenom},\n\nPetit rappel : nous avons rendez-vous le {date_rdv} à {heure_rdv}.\nLieu : {lieu_rdv}\n\nEn cas d'empêchement, merci de me prévenir en répondant à ce mail ou par téléphone.",
};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function rest(chemin: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${chemin}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`REST ${r.status} : ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function egaliteConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function reglages(): Promise<Record<string, string>> {
  const l = await rest("settings?select=cle,valeur&cle=in.(entreprise_nom,entreprise_adresse,entreprise_bce,entreprise_email,entreprise_telephone,entreprise_site,mail_modele_rappel_rdv)");
  return Object.fromEntries((l || []).map((r: { cle: string; valeur: string }) => [r.cle, String(r.valeur ?? "").trim()]));
}

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

/** Même mise en forme que l'aperçu du planning : une ligne vide sépare les paragraphes. */
function construire(modele: { objet: string; corps: string }, v: Record<string, string>, ent: Record<string, string>) {
  // Sans lieu ni prénom, la ligne correspondante disparaît au lieu de rester vide.
  let corps = modele.corps;
  if (!v.lieu_rdv) corps = corps.split("\n").filter((l) => !l.includes("{lieu_rdv}")).join("\n");
  if (!v.prenom) corps = corps.replace(/Bonjour \{prenom\},/g, "Bonjour,");
  const remplir = (t: string, html: boolean) => t.replace(/\{(\w+)\}/g, (x, k) => (k in v ? (html ? esc(v[k]) : v[k]) : x));
  const objet = remplir(modele.objet, false).replace(/[\r\n]+/g, " ").trim();
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#12212e;max-width:560px">` +
    corps.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${remplir(esc(p.trim()), false).replace(/\n/g, "<br>")}</p>`).join("") +
    signatureHTML(ent) + `</div>`;
  return { objet, html };
}

async function envoyer(a: string, objet: string, html: string) {
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
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ a, objet, html, pieces: [] }),
    });
    if (!c.ok) console.error("copie Envoyés", c.status);
  } catch (e) { console.error("copie Envoyés", e); }
}

Deno.serve(async (req) => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ ok: false, error: "Méthode non supportée" }, 405);

  // Seul le cron (jeton de sync_jeton) peut déclencher les envois.
  const recu = req.headers.get("x-sync-jeton") ?? "";
  const lj = (await rest("sync_jeton?select=jeton&id=eq.1"))?.[0];
  if (recu.length < 32 || !lj || !egaliteConstante(recu, String(lj.jeton))) return json({ ok: false, error: "Non autorisé" }, 401);

  const maintenant = new Date(), dans24h = new Date(maintenant.getTime() + 24 * 3600 * 1000);
  const rdvs = await rest(
    `rendezvous?select=id,titre,date_debut,lieu,client_id,reparation_numero&rappel_auto=is.true&rappel_envoye_le=is.null` +
    `&supprime_le=is.null&termine=is.false&client_id=not.is.null` +
    `&date_debut=gt.${encodeURIComponent(maintenant.toISOString())}&date_debut=lte.${encodeURIComponent(dans24h.toISOString())}&limit=50`);
  if (!rdvs?.length) return json({ ok: true, envoyes: 0 });

  const ent = await reglages();
  let modele = MODELE_DEFAUT;
  try {
    const p = JSON.parse(ent.mail_modele_rappel_rdv || "null");
    if (p && String(p.objet || "").trim() && String(p.corps || "").trim()) modele = { objet: p.objet, corps: p.corps };
  } catch { /* texte par défaut */ }

  let envoyes = 0;
  const erreurs: string[] = [];
  for (const r of rdvs) {
    try {
      const cl = (await rest(`clients?select=nom,email&id=eq.${r.client_id}&supprime_le=is.null`))?.[0];
      const email = String(cl?.email || "").trim();
      if (!email) continue;
      // Réservation : seul le premier appel qui remplit rappel_envoye_le envoie.
      const pris = await rest(`rendezvous?id=eq.${r.id}&rappel_envoye_le=is.null`, {
        method: "PATCH", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ rappel_envoye_le: new Date().toISOString() }),
      });
      if (!pris?.length) continue;
      const d = new Date(r.date_debut);
      const v = {
        prenom: String(cl.nom || "").trim().split(/\s+/)[0] || "",
        date_rdv: d.toLocaleDateString("fr-BE", { timeZone: FUSEAU, weekday: "long", day: "numeric", month: "long", year: "numeric" }),
        heure_rdv: d.toLocaleTimeString("fr-BE", { timeZone: FUSEAU, hour: "2-digit", minute: "2-digit" }),
        lieu_rdv: String(r.lieu || "").trim(),
        objet_rdv: String(r.titre || "").trim(),
      };
      const { objet, html } = construire(modele, v, ent);
      try {
        await envoyer(email, objet, html);
        envoyes++;
      } catch (e) {
        // Échec : on libère le rendez-vous pour réessayer au prochain passage.
        await rest(`rendezvous?id=eq.${r.id}`, { method: "PATCH", body: JSON.stringify({ rappel_envoye_le: null }) });
        throw e;
      }
    } catch (e) {
      erreurs.push(`rdv ${r.id} : ${(e as Error).message}`);
      console.error("rappel", r.id, e);
    }
  }
  return json({ ok: erreurs.length === 0, envoyes, erreurs });
});
