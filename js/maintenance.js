import { auth } from './auth.js';
import { supabase } from './config.js';

const $ = id => document.getElementById(id);
const el = {
  guard: $('ownerGuard'), workspace: $('ownerWorkspace'), feedback: $('ownerFeedback'),
  livreur: $('ownerLivreurSelect'), driverCode: $('ownerDriverCode'),
  retire: $('ownerRetireBtn'), reset: $('ownerResetBtn'),
  acknowledge: $('ownerResetAcknowledge'), confirmation: $('ownerResetConfirm'),
  resetCode: $('ownerResetCode'), cleanupPanel: $('ownerCleanupPanel'),
  cleanupCount: $('ownerCleanupCount'), cleanupCode: $('ownerCleanupCode'),
  cleanup: $('ownerCleanupBtn'),
  purgeSelect: $('ownerPurgeSelect'), purgeConfirm: $('ownerPurgeConfirm'),
  purgeCode: $('ownerPurgeCode'), purgeBtn: $('ownerPurgeBtn')
};
let busy = false;

function report(message, error = false) {
  el.feedback.textContent = message;
  el.feedback.classList.toggle('error', error);
  el.feedback.classList.remove('hidden');
}

function setBusy(busyState) {
  busy = busyState;
  el.retire.disabled = busy;
  el.cleanup.disabled = busy;
  validateResetControls();
  validatePurgeControls();
}

function validateResetControls() {
  el.reset.disabled = busy || !el.acknowledge.checked ||
    el.confirmation.value.trim() !== 'EFFACER' || !el.resetCode.value.trim();
}

function validatePurgeControls() {
  el.purgeBtn.disabled = busy || !el.purgeSelect.value
    || el.purgeConfirm.value.trim() !== 'EFFACER LIVREUR'
    || !el.purgeCode.value.trim();
}

async function ownerStatus() {
  const { data, error } = await supabase.rpc('maintenance_owner_status');
  if (error) throw error;
  if (!data?.enabled) throw new Error('Accès non configuré pour ce profil. Utilisez le compte propriétaire et configurez son accès dans Supabase.');
  return data;
}

async function updateCleanupCount() {
  const status = await ownerStatus();
  const count = Number(status.photos_pending || 0);
  el.cleanupPanel.classList.toggle('hidden', count === 0);
  el.cleanupCount.textContent = count === 0 ? 'Toutes les photos ont été traitées.'
    : `${count} photo(s) à supprimer dans le stockage sécurisé.`;
  return count;
}

async function loadLivreurs() {
  // La liste privée inclut les comptes déjà désactivés et masqués dans Équipe.
  const privateResult = await supabase.rpc('maintenance_liste_livreurs');
  let rows;
  if (!privateResult.error) {
    rows = privateResult.data || [];
  } else if (privateResult.error.code === 'PGRST202' || privateResult.error.code === '42883') {
    // Ancienne base, avant installation de la nouvelle migration.
    const { data, error } = await supabase.from('v_livreurs_resume')
      .select('id, nom, zone_nom, actif, en_tournee, nb_tournees, nb_colis_total').order('nom');
    if (error) throw error;
    rows = data || [];
    el.purgeBtn.disabled = true;
  } else {
    throw privateResult.error;
  }
  el.livreur.replaceChildren();
  el.purgeSelect.replaceChildren();
  for (const [select, message] of [
    [el.livreur, 'Choisir un livreur à désactiver'],
    [el.purgeSelect, 'Choisir le livreur à effacer']
  ]) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = rows.length ? message : 'Aucun livreur';
    select.appendChild(placeholder);
  }
  for (const row of rows) {
    const text = `${row.nom} · ${row.zone_nom || 'Sans zone'} · ${row.nb_tournees || 0} tournée(s) · ${row.nb_colis || row.nb_colis_total || 0} colis${row.actif ? '' : ' · DÉSACTIVÉ'}`;
    const opt = document.createElement('option');
    opt.value = row.id;
    opt.textContent = text;
    el.purgeSelect.appendChild(opt);
    if (row.actif) {
      const retire = opt.cloneNode(true);
      el.livreur.appendChild(retire);
    }
  }
  validatePurgeControls();
}

async function removeLivreur() {
  const id = el.livreur.value;
  const code = el.driverCode.value;
  const label = el.livreur.selectedOptions[0]?.textContent || 'ce livreur';
  if (!id || !code.trim()) return report('Sélectionnez un livreur et saisissez votre code privé.', true);
  const status = await ownerStatus().catch(() => null);
  if (!status?.suspension_enabled) {
    el.driverCode.value = '';
    return report('Retrait indisponible : appliquez d’abord la mise à niveau de suspension dans Supabase.', true);
  }
  if (!window.confirm(`Désactiver et masquer ${label} ?\\n\\nSa tournée en cours, ses colis, photos et historiques disparaîtront des écrans habituels. Son accès sera révoqué.\\n\\nLes données restent en base pour un contrôle ultérieur. Les montants non encaissés ne seront PAS clôturés.`)) return;
  setBusy(true);
  el.driverCode.value = '';
  try {
    const { data, error } = await supabase.rpc('maintenance_retire_livreur', {
      p_livreur_id: id, p_secret: code
    });
    if (error) throw error;
    if (!data?.ok) return report(data?.error || 'Action refusée.', true);
    await loadLivreurs();
    report(data.message || 'Livreur retiré.');
  } catch (error) {
    console.error('Retrait du livreur :', error?.code || 'erreur');
    report(error?.message || 'Retrait impossible.', true);
  } finally {
    setBusy(false);
  }
}

async function purgeLivreur() {
  const id = el.purgeSelect.value;
  const code = el.purgeCode.value;
  const selectedName = el.purgeSelect.selectedOptions[0]?.textContent || '';
  if (!id || !code.trim() || el.purgeConfirm.value.trim() !== 'EFFACER LIVREUR') return;
  const question = [
    'SUPPRESSION CIBLÉE DÉFINITIVE',
    selectedName,
    'Ses tournées (même clôturées), ses colis, ses opérations et son compte seront supprimés.',
    'Seuls les dossiers de ce livreur seront retirés des totaux financiers.',
    'Les données des autres livreurs seront conservées.',
    'Confirmer ?'
  ].join('\n\n');
  if (!window.confirm(question)) return;
  setBusy(true);
  el.purgeCode.value = '';
  try {
    const { data, error } = await supabase.rpc('maintenance_effacer_livreur', {
      p_livreur_id: id, p_secret: code
    });
    if (error) throw error;
    if (!data?.ok) return report(data?.error || 'Suppression refusée.', true);
    el.purgeConfirm.value = '';
    await loadLivreurs();
    report(`Compte et dossiers ciblés supprimés : ${data.tournees || 0} tournée(s), ${data.colis || 0} colis. Nettoyage des photos…`);
    try {
      const count = await cleanupPhotos();
      report(`Suppression ciblée terminée. ${count} photo(s) nettoyée(s). Autres livreurs préservés.`);
    } catch (errorPhoto) {
      await updateCleanupCount().catch(() => {});
      report('Données du livreur supprimées des comptes. Des photos restent à nettoyer depuis le panneau privé.', true);
      console.error('Nettoyage ciblé:', errorPhoto?.code || 'erreur');
    }
  } catch (error) {
    console.error('Suppression ciblée:', error?.code || 'erreur');
    report(error?.message || 'Suppression ciblée impossible.', true);
  } finally {
    setBusy(false);
  }
}

async function cleanupPhotos() {
  if (!navigator.onLine) throw new Error('Connexion nécessaire pour supprimer les photos.');
  let total = 0;
  // Keep the UI responsive even with a large backlog: at most 50 photos per API request.
  for (let batches = 0; batches < 1000; batches++) {
    const { data: paths, error: listingError } = await supabase.rpc('maintenance_cleanup_page');
    if (listingError) throw listingError;
    if (!Array.isArray(paths)) throw new Error('Réponse de nettoyage invalide.');
    if (!paths.length) {
      await updateCleanupCount();
      return total;
    }
    const { error: removeError } = await supabase.storage.from('colis-photos').remove(paths);
    if (removeError) throw removeError;
    const { data: marked, error: markerError } = await supabase.rpc('maintenance_mark_photos_removed', {
      p_paths: paths
    });
    if (markerError) throw markerError;
    if (Number(marked) !== paths.length) throw new Error('Le suivi du nettoyage ne correspond pas aux photos supprimées.');
    total += paths.length;
    el.cleanupCount.textContent = `${total} photo(s) supprimée(s) · nettoyage en cours…`;
  }
  throw new Error('Nettoyage interrompu après 50 000 photos. Relancez avec votre code.');
}

async function resetBusinessData() {
  const code = el.resetCode.value;
  if (!el.acknowledge.checked || el.confirmation.value.trim() !== 'EFFACER' || !code.trim()) return;
  if (!window.confirm('CONFIRMATION FINALE : supprimer définitivement tous les colis, tournées, opérations, livreurs et zones ? Les autres sessions seront invalidées.')) return;

  setBusy(true);
  el.resetCode.value = '';
  try {
    report('Réinitialisation sécurisée en cours…');
    const { data, error } = await supabase.rpc('maintenance_reset_business', { p_secret: code });
    if (error) throw error;
    if (!data?.ok) return report(data?.error || 'Réinitialisation refusée.', true);

    el.acknowledge.checked = false;
    el.confirmation.value = '';
    await loadLivreurs();
    report(`Données réinitialisées : ${data.tournees || 0} tournée(s), ${data.colis || 0} colis. Nettoyage des photos en cours…`);
    try {
      const deleted = await cleanupPhotos();
      report(`Réinitialisation terminée. ${deleted} photo(s) supprimée(s). Comptes administrateurs préservés.`);
    } catch (storageError) {
      await updateCleanupCount().catch(() => {});
      report(`Données métier supprimées. Photos à nettoyer : ${storageError?.message || 'reprendre avec le code privé.'}`, true);
    }
  } catch (error) {
    console.error('Réinitialisation :', error?.code || 'erreur');
    report(error?.message || 'Réinitialisation impossible.', true);
  } finally {
    setBusy(false);
  }
}

async function resumeCleanup() {
  const code = el.cleanupCode.value;
  if (!code.trim()) return report('Saisissez le code privé pour reprendre le nettoyage.', true);
  setBusy(true);
  el.cleanupCode.value = '';
  try {
    const { data, error } = await supabase.rpc('maintenance_enable_photo_cleanup', { p_secret: code });
    if (error) throw error;
    if (!data?.ok) return report(data?.error || 'Autorisation refusée.', true);
    const deleted = await cleanupPhotos();
    report(`Nettoyage terminé : ${deleted} photo(s) traitée(s).`);
  } catch (error) {
    console.error('Nettoyage :', error?.code || 'erreur');
    await updateCleanupCount().catch(() => {});
    report(error?.message || 'Nettoyage impossible. Vous pourrez réessayer.', true);
  } finally {
    setBusy(false);
  }
}

async function init() {
  const user = await auth.requireRole(['patronne']);
  if (!user) return;
  try {
    const status = await ownerStatus();
    if (!status.suspension_enabled) {
      el.retire.disabled = true;
      report('Pour désactiver et masquer les données d’un livreur, installez la migration de suspension dans Supabase.', true);
    }
    el.guard.classList.add('hidden');
    el.workspace.classList.remove('hidden');
    [el.acknowledge, el.confirmation, el.resetCode].forEach(input =>
      input.addEventListener('input', validateResetControls));
    el.retire.addEventListener('click', removeLivreur);
    el.reset.addEventListener('click', resetBusinessData);
    el.cleanup.addEventListener('click', resumeCleanup);
    el.purgeBtn.addEventListener('click', purgeLivreur);
    [el.purgeSelect, el.purgeConfirm, el.purgeCode].forEach(input =>
      input.addEventListener('input', validatePurgeControls));
    await Promise.all([loadLivreurs(), updateCleanupCount()]);
  } catch (error) {
    // In particular: feature not yet installed and owner identity not yet configured.
    el.workspace.classList.add('hidden');
    el.guard.replaceChildren();
    const heading = document.createElement('h2');
    heading.className = 'owner-title';
    heading.textContent = 'Accès indisponible';
    const info = document.createElement('p');
    info.className = 'owner-text';
    info.textContent = 'Ce module nécessite la configuration privée du profil propriétaire dans Supabase.';
    el.guard.append(heading, info);
    console.error('Administration privée :', error?.code || 'non configurée');
  }
}

document.addEventListener('DOMContentLoaded', init);
