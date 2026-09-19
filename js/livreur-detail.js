import { auth } from './auth.js';
import { supabase } from './config.js';
import { enableAutoSync } from './auto-sync.js';
import { formatFcfa, formatDate, getQueryParam, createEmptyState, createBadge } from './page-utils.js';

const livreurId = getQueryParam('id');

const pageTitle = document.getElementById('pageTitle');
const statusText = document.getElementById('statusText');
const statTours = document.getElementById('statTours');
const statDelivered = document.getElementById('statDelivered');
const statReturns = document.getElementById('statReturns');
const statCollected = document.getElementById('statCollected');
const editNom = document.getElementById('editNom');
const editTel = document.getElementById('editTel');
const editZone = document.getElementById('editZone');
const editActif = document.getElementById('editActif');
const saveProfileBtn = document.getElementById('saveProfileBtn');
const callBtn = document.getElementById('callBtn');
const pinSection = document.getElementById('pinSection');
const newPin = document.getElementById('newPin');
const resetPinBtn = document.getElementById('resetPinBtn');
const historyList = document.getElementById('historyList');

let role = null;
let livreur = null;

async function loadZones() {
  const { data, error } = await supabase
    .from('zones')
    .select('id, nom, actif')
    .order('nom');

  if (error) throw error;
  editZone.replaceChildren();

  (data || []).forEach(zone => {
    const option = document.createElement('option');
    option.value = zone.id;
    option.textContent = zone.actif ? zone.nom : `${zone.nom} (inactive)`;
    editZone.appendChild(option);
  });
}

async function loadLivreur() {
  const { data, error } = await supabase
    .from('v_livreurs_resume')
    .select('*')
    .eq('id', livreurId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    // Le profil peut avoir ete desactive depuis une autre tablette.
    window.location.replace('livreurs.html');
    throw new Error('Livreur indisponible ou desactive.');
  }

  livreur = data;

  pageTitle.textContent = data.nom.toUpperCase();
  statusText.textContent = !data.actif ? 'Compte inactif' : (data.en_tournee ? 'En tournée' : 'Disponible');

  statTours.textContent = String(Number(data.nb_tournees || 0));
  statDelivered.textContent = String(Number(data.nb_colis_livres || 0));
  statReturns.textContent = String(Number(data.nb_colis_retournes || 0));
  statCollected.textContent = formatFcfa(data.total_encaisse);

  editNom.value = data.nom || '';
  editTel.value = data.telephone || '';
  editZone.value = data.zone_id || '';
  editActif.checked = !!data.actif;
  callBtn.href = data.telephone ? `tel:${data.telephone}` : '#';
}

async function loadHistory() {
  const { data, error } = await supabase
    .from('v_sorties_resume')
    .select('id, statut, zone_nom, created_at, closed_at, nb_colis_total, montant_chargement, net_a_encaisser, montant_final')
    .eq('livreur_id', livreurId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;

  historyList.replaceChildren();
  if (!data?.length) {
    historyList.appendChild(createEmptyState('Aucune tournée pour ce livreur.'));
    return;
  }

  data.forEach(tour => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.style.cursor = 'pointer';

    const main = document.createElement('div');
    main.className = 'list-main';

    const title = document.createElement('div');
    title.className = 'list-title';
    title.textContent = `${tour.zone_nom || 'Sans zone'} • ${formatDate(tour.closed_at || tour.created_at, true)}`;

    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.textContent = `${tour.nb_colis_total} colis • Chargement ${formatFcfa(tour.montant_chargement)}`;

    main.append(title, meta);

    const right = document.createElement('div');
    right.style.textAlign = 'right';
    const amount = document.createElement('div');
    amount.className = 'list-amount';
    amount.textContent = formatFcfa(tour.statut === 'cloturee' ? tour.montant_final : tour.net_a_encaisser);
    right.append(amount, createBadge(tour.statut === 'cloturee' ? 'CLÔTURÉE' : 'EN COURS', tour.statut === 'cloturee' ? 'success' : 'primary'));

    row.append(main, right);
    row.addEventListener('click', () => {
      window.location.href = `dossier-detail.html?id=${encodeURIComponent(tour.id)}`;
    });
    historyList.appendChild(row);
  });
}

async function saveProfile() {
  if (!livreur) return;

  const nom = editNom.value.trim();
  const zoneId = editZone.value;
  if (!nom || !zoneId) return alert('Nom et zone obligatoires.');

  saveProfileBtn.disabled = true;
  try {
    const { error } = await supabase.rpc('update_livreur_account', {
      p_livreur_id: livreurId,
      p_nom: nom,
      p_telephone: editTel.value.trim(),
      p_zone_id: zoneId,
      p_actif: editActif.checked
    });

    if (error) throw error;
    await Promise.all([loadLivreur(), loadHistory()]);
    alert('Profil mis à jour.');
  } catch (err) {
    alert(err.message || 'Impossible de modifier le livreur.');
  } finally {
    saveProfileBtn.disabled = false;
  }
}

async function resetPin() {
  const pin = newPin.value.trim();
  if (!/^\d{4}$/.test(pin)) return alert('Le PIN doit contenir 4 chiffres.');

  resetPinBtn.disabled = true;
  try {
    const { error } = await supabase.rpc('reset_livreur_pin', {
      p_livreur_id: livreurId,
      p_pin: pin
    });

    if (error) throw error;
    newPin.value = '';
    alert('Nouveau code PIN enregistré. Les anciennes sessions du livreur ont été fermées.');
  } catch (err) {
    alert(err.message || 'Impossible de modifier le PIN.');
  } finally {
    resetPinBtn.disabled = false;
  }
}

async function init() {
  if (!livreurId) {
    window.location.replace('livreurs.html');
    return;
  }

  const user = await auth.requireRole(['gerant', 'patronne']);
  if (!user) return;

  role = await auth.getCurrentRole();

  if (role !== 'gerant') {
    [editNom, editTel, editZone, editActif].forEach(el => el.disabled = true);
    saveProfileBtn.classList.add('hidden');
    pinSection.classList.add('hidden');
  } else {
    saveProfileBtn.addEventListener('click', saveProfile);
    resetPinBtn.addEventListener('click', resetPin);
  }

  try {
    await loadZones();
    await Promise.all([loadLivreur(), loadHistory()]);
    enableAutoSync(async () => {
      await loadLivreur();
      await loadHistory();
    }, {
      tables: ['livreurs', 'sorties', 'colis'], intervalMs: 30000,
      shouldRefresh: () => !document.activeElement?.matches('input, textarea, select')
    });
  } catch (err) {
    console.error(err);
    historyList.replaceChildren(createEmptyState(err.message || 'Erreur de chargement.'));
  }
}

document.addEventListener('DOMContentLoaded', init);
