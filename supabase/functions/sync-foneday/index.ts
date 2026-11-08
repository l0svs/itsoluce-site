// ═══════════════════════════════════════════════════════════
//  IT Soluce — Agent de synchronisation Foneday
//  Edge Function Supabase : sync-foneday
//  Récupère le catalogue Foneday, applique la grille dégressive,
//  met à jour la table foneday_produits + trace l'historique.
// ════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Grille de tarification dégressive (identique à l'ERP) ───
const GRILLE = [
  { min: 0,   max: 30,     coef: 2.2,  fixe: 25 },
  { min: 30,  max: 80,     coef: 1.8,  fixe: 25 },
  { min: 80,  max: 150,    coef: 1.45, fixe: 35 },
  { min: 150, max: 250,    coef: 1.25, fixe: 45 },
  { min: 250, max: 999999, coef: 1.15, fixe: 55 },
];

const FRAIS_LIVRAISON = 6.50;

function calcPrixVente(achat: number): number {
  if (!achat || achat <= 0) return 0;
  const cout = achat + FRAIS_LIVRAISON;
  const p = GRILLE.find((x) => cout >= x.min && cout < x.max) || GRILLE[GRILLE.length - 1];
  return Math.round((cout * p.coef + p.fixe) * 100) / 100;
}

// ─── Mapping qualité (+ catégorie + titre) → niveau commercial ───
// Validé manuellement avec Linton, catégorie par catégorie :
//  - Écran (Display) : mapping simple par qualité
//  - Batterie (Battery) : logique dediée (variantes Calibrated Used/Genuine,
//    exclusion Without BMS / High Capacity / FDX)
// Les catégories pas encore calibrées utilisent le mapping générique par défaut.
function niveauDepuisQualite(quality: string, category: string, title: string): string {
  const q = (quality || "").trim();
  const cat = (category || "").trim();
  const t = (title || "").toLowerCase();

  // Exclusion globale : marque interne Foneday non retenue par Linton
  if (t.includes("fdx")) return "a_valider";

  if (cat === "Battery") {
    if (t.includes("without bms") || t.includes("high capacity")) return "a_valider";
    if (q === "OEM-Equivalent") {
      if (t.includes("calibrated genuine")) return "recommande";
      return "eco"; // Calibrated Used + autres marques sans distinction Foneday
    }
    if (q === "Pulled A") return "recommande_plus";
    if (q === "Service Pack") return "premium";
    return "a_valider"; // Pulled B / Pulled C non retenues sur Batterie
  }

  // Mapping generique (utilise pour Ecran, et par defaut ailleurs)
  const MAPPING: Record<string, string> = {
    "OEM-Equivalent": "eco",
    "Refurbished": "recommande",
    "Pulled A": "recommande_plus",
    "Service Pack": "premium",
  };
  return MAPPING[q] || "a_valider";
}

const SEUIL_ALERTE_PCT = 25;

// Part minimale du catalogue qui doit revenir de l'API pour qu'on ose
// marquer les absents en rupture. Si Foneday ne renvoie qu'une poignée de
// produits — incident, réponse tronquée, changement d'API — passer tout le
// reste en rupture viderait le catalogue d'un coup. Dans ce cas on upsert
// quand même ce qui est arrivé, mais on ne déclare personne en rupture.
const SEUIL_RUPTURE_MIN = 0.5;

const MARQUES = ["apple","samsung","huawei","xiaomi","google","pixel","oneplus","oppo","honor","sony","playstation","microsoft","xbox","nintendo","switch"];
function marqueAutorisee(prod) {
  const champs = ((prod.model_brand||"")+" "+(prod.title||"")+" "+(prod.suitable_for||"")+" "+(prod.category||"")).toLowerCase();
  return MARQUES.some((m) => champs.includes(m));
}

Deno.serve(async (req) => {
  try {
    const FONEDAY_TOKEN = Deno.env.get("FONEDAY_TOKEN");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!FONEDAY_TOKEN) throw new Error("FONEDAY_TOKEN manquant dans les secrets");
    const sb = createClient(SUPABASE_URL!, SERVICE_KEY!);

    const url = new URL(req.url);
    const dryRun = url.searchParams.get("dry") === "1";

    const resp = await fetch("https://foneday.shop/api/v1/products", {
      headers: { "Authorization": `Bearer ${FONEDAY_TOKEN}` },
    });
    if (!resp.ok) throw new Error(`Foneday API erreur ${resp.status}`);
    const data = await resp.json();
    const produits = data.products || [];

    if (!Array.isArray(produits) || produits.length === 0) {
      return new Response(JSON.stringify({ ok: false, message: "Catalogue vide, base inchangée" }), {
        headers: { "Content-Type": "application/json" }, status: 200,
      });
    }

    const { data: existants } = await sb.from("foneday_produits").select("sku, prix_achat");
    const prixExistants: Record<string, number> = {};
    (existants || []).forEach((p: any) => { prixExistants[p.sku] = Number(p.prix_achat); });

    // Horodatage unique pour toute la passe : il sert ensuite de ligne de
    // partage entre « revu dans cette synchro » et « plus proposé ». Un
    // new Date() par ligne rendrait cette comparaison inexacte.
    const debutSynchro = new Date().toISOString();

    const rows: any[] = [];
    const historique: any[] = [];
    const alertes: string[] = [];

    for (const prod of produits) {
      if (prod.instock !== "Y") continue;
      if (!marqueAutorisee(prod)) continue;
      const achat = Number(prod.price) || 0;
      const vente = calcPrixVente(achat);
      const niveau = niveauDepuisQualite(prod.quality, prod.category, prod.title);

      const ancienPrix = prixExistants[prod.sku];
      if (ancienPrix !== undefined && ancienPrix !== achat) {
        const variation = ancienPrix > 0 ? ((achat - ancienPrix) / ancienPrix) * 100 : 0;
        historique.push({
          sku: prod.sku, title: prod.title,
          ancien_prix: ancienPrix, nouveau_prix: achat,
          variation_pct: Math.round(variation * 100) / 100,
        });
        if (Math.abs(variation) >= SEUIL_ALERTE_PCT) {
          alertes.push(`${prod.title} : ${ancienPrix}€ → ${achat}€ (${variation > 0 ? "+" : ""}${Math.round(variation)}%)`);
        }
      }

      rows.push({
        sku: prod.sku,
        ean: prod.ean || null,
        title: prod.title || null,
        suitable_for: prod.suitable_for || null,
        category: prod.category || null,
        quality: prod.quality || null,
        model_brand: prod.model_brand || null,
        model_codes: prod.model_codes || null,
        prix_achat: achat,
        prix_vente_calcule: vente,
        niveau: niveau,
        instock: prod.instock === "Y",
        synced_at: debutSynchro,
      });
    }

    if (dryRun) {
      return new Response(JSON.stringify({
        ok: true, dryRun: true,
        total: rows.length,
        changements: historique.length,
        alertes,
        apercu: rows.slice(0, 3),
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    const uniques = new Map();
    for (const r of rows) { uniques.set(r.sku, r); }
    const rowsUniques = Array.from(uniques.values());

    const BATCH = 500;
    for (let i = 0; i < rowsUniques.length; i += BATCH) {
      const lot = rowsUniques.slice(i, i + BATCH);
      const { error: upErr } = await sb.from("foneday_produits").upsert(lot, { onConflict: "sku" });
      if (upErr) throw new Error(`Upsert lot ${i}-${i + lot.length} : ${upErr.message}`);
    }

    // ─── Passage en rupture des produits que Foneday ne propose plus ───
    //
    // La boucle ci-dessus saute les produits hors stock : ils n'arrivent donc
    // jamais dans l'upsert, et sans ce bloc ils restaient en base avec leur
    // ancien « instock: true ». Le catalogue affichait alors « En stock » des
    // pièces introuvables, parfois depuis des mois.
    //
    // Tout ce qui n'a pas été revu pendant cette passe porte encore un
    // synced_at antérieur : c'est le marqueur de l'absence. Le garde-fou
    // SEUIL_RUPTURE_MIN empêche qu'une réponse API anormalement courte ne
    // bascule tout le catalogue en rupture.
    const totalEnBase = (existants || []).length;
    let misEnRupture = 0;
    let ruptureIgnoree = false;

    if (totalEnBase > 0 && rowsUniques.length < totalEnBase * SEUIL_RUPTURE_MIN) {
      ruptureIgnoree = true;
    } else {
      // « count » plutôt qu'un select : seul le nombre nous intéresse, et
      // rapatrier plusieurs milliers de SKU pour les compter serait du
      // transfert pur perte.
      const { count, error: rupErr } = await sb
        .from("foneday_produits")
        .update({ instock: false }, { count: "exact" })
        .lt("synced_at", debutSynchro)
        .eq("instock", true);
      if (rupErr) throw new Error(`Passage en rupture : ${rupErr.message}`);
      misEnRupture = count ?? 0;
    }

    for (let i = 0; i < historique.length; i += BATCH) {
      await sb.from("foneday_historique").insert(historique.slice(i, i + BATCH));
    }

    return new Response(JSON.stringify({
      ok: true,
      total: rowsUniques.length,
      changements: historique.length,
      mis_en_rupture: misEnRupture,
      rupture_ignoree: ruptureIgnoree,
      alertes,
    }, null, 2), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), {
      headers: { "Content-Type": "application/json" }, status: 500,
    });
  }
});
