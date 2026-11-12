// ═══════════════════════════════════════════════════════════
//  IT Soluce — Agenda synchronisé (abonnement iCal)
//  Edge Function Supabase : agenda-ics   (verify_jwt désactivé)
//
//  Le calendrier du téléphone (iPhone, Google Agenda…) s'abonne à
//  https://…/functions/v1/agenda-ics?t=<jeton> et relit régulièrement les
//  rendez-vous du Planning. Sens unique : ERP → calendrier.
//
//  SÉCURITÉ — un calendrier ne sait pas s'authentifier : l'accès repose sur
//  un jeton secret de 64 caractères (table agenda_jeton, lisible seulement
//  par le service). Comparaison en temps constant ; jeton régénérable dans
//  Gestion › Intégrations si le lien a circulé.
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

function egaliteConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Texte iCal : antislash, point-virgule, virgule et retours à la ligne échappés.
const esc = (v: unknown) =>
  String(v ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// Date UTC au format iCal : 20261112T143000Z
const utc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// Lignes de 75 octets maximum (RFC 5545), coupées sans casser un caractère UTF-8.
function plier(ligne: string): string {
  const enc = new TextEncoder();
  if (enc.encode(ligne).length <= 75) return ligne;
  const morceaux: string[] = [];
  let cur = "";
  let taille = 0;
  for (const ch of ligne) {
    const n = enc.encode(ch).length;
    const max = morceaux.length ? 74 : 75; // la suite commence par une espace
    if (taille + n > max) {
      morceaux.push(cur);
      cur = "";
      taille = 0;
    }
    cur += ch;
    taille += n;
  }
  morceaux.push(cur);
  return morceaux.join("\r\n ");
}

const TYPES: Record<string, string> = { domicile: "Intervention à domicile", depot: "Dépôt / restitution" };

Deno.serve(async (req) => {
  const refus = () => new Response("Accès refusé", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Méthode non supportée", { status: 405 });
    const jeton = new URL(req.url).searchParams.get("t") ?? "";
    if (jeton.length < 32) return refus();

    const rj = await fetch(`${SUPABASE_URL}/rest/v1/agenda_jeton?select=jeton&id=eq.1`, { headers: svc });
    const lignesJ = rj.ok ? await rj.json() : [];
    const attendu = String(lignesJ?.[0]?.jeton ?? "");
    if (!attendu || !egaliteConstante(jeton, attendu)) return refus();

    // 3 mois en arrière, 12 mois en avant : assez pour le quotidien, léger pour le téléphone.
    const depuis = new Date(Date.now() - 92 * 86400000).toISOString();
    const jusqua = new Date(Date.now() + 366 * 86400000).toISOString();
    const rr = await fetch(
      `${SUPABASE_URL}/rest/v1/rendezvous?select=id,titre,type,date_debut,date_fin,client_nom,reparation_numero,lieu,notes,termine,updated_at` +
        `&supprime_le=is.null&date_debut=gte.${encodeURIComponent(depuis)}&date_debut=lte.${encodeURIComponent(jusqua)}&order=date_debut.asc`,
      { headers: svc },
    );
    if (!rr.ok) {
      console.error("Lecture des rendez-vous impossible", rr.status, await rr.text());
      return new Response("Erreur temporaire", { status: 503 });
    }
    // deno-lint-ignore no-explicit-any
    const rdvs: any[] = await rr.json();

    const maintenant = utc(new Date());
    const out: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//IT Soluce//ERP//FR",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:IT Soluce",
      "X-WR-TIMEZONE:Europe/Brussels",
      "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
      "X-PUBLISHED-TTL:PT15M",
    ];
    for (const r of rdvs) {
      const debut = new Date(r.date_debut);
      if (isNaN(debut.getTime())) continue;
      let fin = r.date_fin ? new Date(r.date_fin) : new Date(debut.getTime() + 60 * 60000);
      if (isNaN(fin.getTime()) || fin <= debut) fin = new Date(debut.getTime() + 60 * 60000);
      const type = TYPES[r.type] || "Rendez-vous";
      const titre = (r.titre && String(r.titre).trim()) || `${type}${r.client_nom ? " · " + r.client_nom : ""}`;
      const desc = [
        r.client_nom ? `Client : ${r.client_nom}` : "",
        r.reparation_numero ? `Dossier : ${r.reparation_numero}` : "",
        type,
        r.notes ? `\n${r.notes}` : "",
        "\nOuvrir le planning : https://itsoluce.be/admin/planning.html",
      ].filter(Boolean).join("\n");
      out.push(
        "BEGIN:VEVENT",
        `UID:rdv-${r.id}@itsoluce.be`,
        `DTSTAMP:${maintenant}`,
        `LAST-MODIFIED:${utc(new Date(r.updated_at || r.date_debut))}`,
        `DTSTART:${utc(debut)}`,
        `DTEND:${utc(fin)}`,
        `SUMMARY:${esc((r.termine ? "✓ " : "") + titre)}`,
        ...(r.lieu ? [`LOCATION:${esc(r.lieu)}`] : []),
        `DESCRIPTION:${esc(desc)}`,
        "URL:https://itsoluce.be/admin/planning.html",
        "STATUS:CONFIRMED",
        "END:VEVENT",
      );
    }
    out.push("END:VCALENDAR");
    const corps = out.map(plier).join("\r\n") + "\r\n";
    return new Response(req.method === "HEAD" ? null : corps, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="itsoluce.ics"',
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    console.error("agenda-ics", err);
    return new Response("Erreur temporaire", { status: 503 });
  }
});
