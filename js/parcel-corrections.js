import { supabase } from './config.js';
import { formatFcfa } from './page-utils.js';

/**
 * Correction d'une saisie (pas un retour, ni une livraison).
 * Le serveur retire le colis + ses operations dans une transaction et recalcule
 * la cloture si necessaire. Le navigateur ne peut pas creer de debit fictif.
 */
export async function correctParcelEntry(parcel, { after, setBusy, notify } = {}) {
  if (!parcel?.id) return false;
  const promptText = [
    'CORRIGER UNE ERREUR DE SAISIE',
    'Colis : ' + formatFcfa(parcel.valeur),
    'Cette action retire le colis des comptes, des retours et des statistiques.',
    'Elle ne représente NI une livraison, NI un retour, NI une remise d’argent.',
    'Indiquez le motif (minimum 5 caractères) :'
  ].join('\n\n');
  const reason = window.prompt(promptText);
  if (reason === null) return false;
  const motif = reason.trim();
  if (motif.length < 5 || motif.length > 180) {
    notify?.('Précisez un motif de 5 à 180 caractères.', true);
    return false;
  }
  const confirmed = window.confirm([
    'CONFIRMER LA CORRECTION ?',
    'Colis : ' + formatFcfa(parcel.valeur),
    'Sa photo et ses éventuels retours/déductions seront retirés.',
    'Si la tournée était clôturée, son montant final sera recalculé.',
    'Motif : ' + motif
  ].join('\n\n'));
  if (!confirmed) return false;
  setBusy?.(true);
  let committed = false;
  try {
    const { data, error } = await supabase.rpc('corriger_colis_saisi', {
      p_colis_id: parcel.id,
      p_motif: motif
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'Correction non confirmée.');
    committed = true;

    // Toujours rafraîchir après l'écriture en base, même si Storage échoue.
    let refreshError = null;
    try { await after?.(); } catch (err) { refreshError = err; }

    let photoError = null;
    if (data.photo_path) {
      try {
        const { error: removeError } = await supabase.storage
          .from('colis-photos').remove([data.photo_path]);
        if (removeError) throw removeError;
        const { data: marked, error: confirmError } = await supabase
          .rpc('confirmer_photo_colis_corrigee', { p_colis_id: parcel.id });
        if (confirmError) throw confirmError;
        if (!marked?.ok) throw new Error(marked?.error || 'Nettoyage photo à vérifier.');
      } catch (err) {
        photoError = err;
        console.error('Photo de colis corrigé à nettoyer :', err?.message || err);
      }
    }

    if (photoError || refreshError) {
      notify?.('Colis retiré des comptes. ' +
        (photoError ? 'Photo en attente de nettoyage privé. ' : '') +
        (refreshError ? 'Actualisez la page pour vérifier le nouveau total.' : ''), true);
    } else {
      notify?.('Colis corrigé. Total et comptabilité recalculés.');
    }
    return true;
  } catch (err) {
    console.error('Correction de saisie :', err);
    if (committed) notify?.('Colis corrigé en base. Actualisez la page pour vérifier.', true);
    else notify?.(err?.message || 'Correction impossible. Aucun colis confirmé supprimé.', true);
    return committed;
  } finally {
    setBusy?.(false);
  }
}
