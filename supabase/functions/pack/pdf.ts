// ═══════════════════════════════════════════════════════════
//  Facture PDF générée côté serveur (achat de pack en ligne).
//  Même contenu légal que les factures de l'ERP : identité et n° d'entreprise
//  d'IT Soluce, client, numéro, date, lignes, total, mention TVA (franchise).
// ═══════════════════════════════════════════════════════════
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

// deno-lint-ignore no-explicit-any
type Doc = any;

// Les polices standard du PDF ne couvrent que le jeu WinAnsi : on remplace
// les quelques caractères typographiques qui n'y figurent pas.
const propre = (s: unknown) => String(s ?? "")
  .replace(/[   ]/g, " ")
  .replace(/−/g, "-")
  .replace(/[→]/g, "->")
  .replace(/[^\u0000-ÿ€—–’‘“”…Œœ›‹•]/g, "");
const EUR = new Intl.NumberFormat("fr-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (v: unknown) => propre(EUR.format(Number(v) || 0)) + " €";
const dFr = (d: unknown) => {
  const s = String(d ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "";
};
const MODES: Record<string, string> = { carte: "carte", especes: "espèces", virement: "virement", mixte: "carte + espèces", en_ligne: "paiement en ligne (Mollie)" };

export function mentionTva(v: unknown): string {
  const t = String(v ?? "").trim();
  return !t || /^TVA non applicable,? (art\.|article) 56bis/i.test(t) ? "Régime particulier de franchise des petites entreprises" : t;
}

export async function facturePdf(f: Doc, ent: Record<string, string>, logo?: Uint8Array | null): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Facture ${f.numero}`);
  pdf.setAuthor(ent.entreprise_nom || "IT Soluce");
  const page = pdf.addPage([595.28, 841.89]);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const gras = await pdf.embedFont(StandardFonts.HelveticaBold);
  const bleu = rgb(0, 0.32, 0.8), noir = rgb(0.07, 0.13, 0.18), gris = rgb(0.35, 0.42, 0.48), trait = rgb(0.89, 0.91, 0.93);
  const M = 50, L = 595.28 - 2 * M;
  const ecr = (t: unknown, x: number, y: number, o: { t?: number; f?: typeof reg; c?: ReturnType<typeof rgb>; droite?: boolean } = {}) => {
    const s = propre(t), taille = o.t || 10, fo = o.f || reg;
    page.drawText(s, { x: o.droite ? x - fo.widthOfTextAtSize(s, taille) : x, y, size: taille, font: fo, color: o.c || noir });
  };
  const couper = (t: unknown, larg: number, taille: number, fo = reg) => {
    const mots = propre(t).split(/\s+/), lignes: string[] = [];
    let l = "";
    for (const m of mots) {
      const essai = l ? l + " " + m : m;
      if (fo.widthOfTextAtSize(essai, taille) > larg && l) { lignes.push(l); l = m; } else l = essai;
    }
    if (l) lignes.push(l);
    return lignes.length ? lignes : [""];
  };

  // En-tête : logo + identité d'IT Soluce, à droite le document.
  let y = 841.89 - M;
  let hLogo = 0;
  if (logo) {
    try {
      const img = await pdf.embedPng(logo);
      const h = 34, w = img.width * h / img.height;
      page.drawImage(img, { x: M, y: y - h, width: w, height: h });
      hLogo = h + 10;
    } catch { /* logo illisible : on écrit le nom */ }
  }
  if (!hLogo) { ecr(ent.entreprise_nom || "IT Soluce", M, y - 16, { t: 18, f: gras, c: bleu }); hLogo = 26; }
  let yg = y - hLogo - 4;
  for (const l of [ent.entreprise_nom || "IT Soluce", ent.entreprise_adresse, ent.entreprise_bce ? "N° d'entreprise : " + ent.entreprise_bce : "",
    [ent.entreprise_telephone, ent.entreprise_email].filter(Boolean).join(" · ")].filter(Boolean)) {
    ecr(l, M, yg, { t: 9.5, c: gris }); yg -= 13;
  }
  const nc = f.type_document === "note_credit";
  ecr(nc ? "NOTE DE CRÉDIT" : "FACTURE", M + L, y - 16, { t: 20, f: gras, c: bleu, droite: true });
  let yd = y - 36;
  for (const [k, v] of [["N°", f.numero], ["Date", dFr(f.date_emission)],
    ...(f.statut === "payee" && f.date_paiement ? [["Payée le", dFr(f.date_paiement) + (f.mode_paiement ? " · " + (MODES[f.mode_paiement] || f.mode_paiement) : "")]] : [])]) {
    ecr(`${k} : ${v}`, M + L, yd, { t: 10, droite: true }); yd -= 14;
  }

  // Client
  y = Math.min(yg, yd) - 22;
  ecr("Facturé à", M, y, { t: 9, f: gras, c: gris }); y -= 14;
  for (const l of [f.client_societe, f.client_nom, ...String(f.client_adresse || "").split(/\n/), f.client_tva ? "TVA : " + f.client_tva : ""].filter(Boolean)) {
    ecr(l, M, y, { t: 10.5 }); y -= 14;
  }

  // Lignes
  y -= 14;
  const cQ = M + 330, cP = M + 410, cT = M + L;
  ecr("Description", M, y, { t: 8.5, f: gras, c: gris }); ecr("Qté", cQ, y, { t: 8.5, f: gras, c: gris, droite: true });
  ecr("Prix unitaire", cP, y, { t: 8.5, f: gras, c: gris, droite: true }); ecr("Total", cT, y, { t: 8.5, f: gras, c: gris, droite: true });
  y -= 7; page.drawLine({ start: { x: M, y }, end: { x: M + L, y }, thickness: 0.8, color: trait }); y -= 15;
  for (const l of Array.isArray(f.lignes) ? f.lignes : []) {
    const d = couper(l.description, 300, 10);
    d.forEach((t, i) => ecr(t, M, y - i * 13, { t: 10 }));
    ecr(String(l.quantite ?? 1), cQ, y, { t: 10, droite: true });
    ecr(eur(l.prix_unitaire), cP, y, { t: 10, droite: true });
    ecr(eur(l.total ?? (Number(l.quantite) || 1) * (Number(l.prix_unitaire) || 0)), cT, y, { t: 10, droite: true });
    y -= d.length * 13 + 7;
    page.drawLine({ start: { x: M, y: y + 3 }, end: { x: M + L, y: y + 3 }, thickness: 0.5, color: trait });
    y -= 10;
  }
  if (Number(f.remise) > 0) { ecr("Remise", M, y, { t: 10, c: gris }); ecr("- " + eur(f.remise), cT, y, { t: 10, c: gris, droite: true }); y -= 18; }
  y -= 4;
  ecr("Total", cP, y, { t: 13, f: gras, droite: true }); ecr(eur(f.total), cT, y, { t: 13, f: gras, droite: true });
  y -= 18;
  if (!nc && f.statut === "payee") { ecr("Montant payé - rien à régler.", cT, y, { t: 9.5, c: gris, droite: true }); y -= 14; }
  if (f.motif_credit) { ecr("Motif : " + f.motif_credit, M, y, { t: 10 }); y -= 14; }

  // Mentions
  y -= 16;
  for (const l of [mentionTva(ent.finance_mention_tva) + ".",
    "Conditions générales et garantie : itsoluce.be (rubrique Conditions)."]) {
    for (const t of couper(l, L, 9)) { ecr(t, M, y, { t: 9, c: gris }); y -= 12; }
  }
  // Pied
  page.drawLine({ start: { x: M, y: 50 }, end: { x: M + L, y: 50 }, thickness: 0.5, color: trait });
  ecr([ent.entreprise_nom || "IT Soluce", ent.entreprise_adresse, ent.entreprise_bce].filter(Boolean).join(" · "), M + L / 2 - reg.widthOfTextAtSize(propre([ent.entreprise_nom || "IT Soluce", ent.entreprise_adresse, ent.entreprise_bce].filter(Boolean).join(" · ")), 8) / 2, 38, { t: 8, c: gris });
  return await pdf.save();
}
