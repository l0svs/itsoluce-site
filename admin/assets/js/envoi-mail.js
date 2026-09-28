/**
 * Envoi d'un mail depuis Devis, Factures et Planning.
 *
 * 1. Par ta boîte OVH (fonction « mail ») : le mail part de contact@itsoluce.be,
 *    une copie est déposée dans « Envoyés » et il apparaît dans la page Messages.
 * 2. Repli sur l'ancien envoi (Resend) si la boîte OVH ne répond pas ou
 *    renvoie une erreur serveur. Une erreur de saisie (adresse invalide…)
 *    n'est PAS renvoyée par Resend : elle est affichée telle quelle.
 *
 * Renvoie { via: 'ovh' | 'resend', avertissement }.
 */
window.envoyerMailERP = async function (o) {
  // o = { SB, jeton, to, subject, html, pdfBase64?, pdfName?, repli: 'send-invoice' | 'send-reminder' }
  const entetes = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + o.jeton };
  let raisonRepli = null;
  try {
    const res = await fetch(o.SB + '/functions/v1/mail', {
      method: 'POST',
      headers: entetes,
      body: JSON.stringify({
        action: 'envoyer_html', a: o.to, objet: o.subject, html: o.html,
        pieces: o.pdfBase64 ? [{ nom: o.pdfName || 'document.pdf', type: 'application/pdf', base64: o.pdfBase64 }] : []
      })
    });
    const r = await res.json().catch(() => ({}));
    if (res.ok) return { via: 'ovh', avertissement: r.avertissement || null };
    // 4xx : le problème vient du message lui-même, Resend le refuserait aussi.
    if (res.status < 500) throw new Error(r.error || "Échec de l'envoi");
    raisonRepli = r.error || ('erreur ' + res.status);
  } catch (e) {
    if (raisonRepli === null && e instanceof Error && !(e instanceof TypeError)) throw e;
    raisonRepli = raisonRepli || 'boîte OVH injoignable';
  }
  console.warn('Envoi OVH impossible, repli sur Resend :', raisonRepli);
  const corps = { to: o.to, subject: o.subject, html: o.html };
  if (o.pdfBase64) { corps.pdfBase64 = o.pdfBase64; corps.pdfName = o.pdfName; }
  const res2 = await fetch(o.SB + '/functions/v1/' + o.repli, { method: 'POST', headers: entetes, body: JSON.stringify(corps) });
  const r2 = await res2.json().catch(() => ({}));
  if (!res2.ok) throw new Error(r2.error || "Échec de l'envoi");
  return { via: 'resend', avertissement: 'Envoyé par le service de secours (la boîte OVH ne répondait pas) : pas de copie dans « Envoyés ».' };
};
