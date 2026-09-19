import { auth } from './auth.js';
import { supabase } from './config.js';
import { createEmptyState } from './page-utils.js';

const createSection = document.getElementById('createSection');
const toggleCreateBtn = document.getElementById('toggleCreateBtn');
const createLivreurBtn = document.getElementById('createLivreurBtn');
const zonesLink = document.getElementById('zonesLink');
const livreurList = document.getElementById('livreurList');
const teamMeta = document.getElementById('teamMeta');
const newNom = document.getElementById('newNom');
const newTel = document.getElementById('newTel');
const newZone = document.getElementById('newZone');
const newPin = document.getElementById('newPin');

let role = null;

async function loadZones() {
  const { data, error } = await supabase
    .from('zones')
    .select('id, nom, actif')
    .eq('actif', true)
    .order('nom');

  if (error) throw error;

  newZone.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- Choisir une zone --';
  newZone.appendChild(placeholder);

  (data || []).forEach(zone => {
    const opt = document.createElement('option');
    opt.value = zone.id;
    opt.textContent = zone.nom;
    newZone.appendChild(opt);
  });
}

function makeLivreurRow(l) {
  const row = document.createElement('div');
  row.className = 'list-row';
  row.style.cursor = 'pointer';

  const main = document.createElement('div');
  main.className = 'list-main';

  const title = document.createElement('div');
  title.className = 'list-title';
  title.textContent = l.nom;

  const meta = document.createElement('div');
  meta.className = 'list-meta';
  const state = !l.actif ? 'Inactif' : (l.en_tournee ? 'En tournée' : 'Libre');
  meta.textContent = `${l.zone_nom || 'Sans zone'} • ${l.telephone || 'Sans téléphone'} • ${state}`;

  main.append(title, meta);

  const right = document.createElement('div');
  right.style.textAlign = 'right';

  const badge = document.createElement('span');
  badge.className = `badge ${!l.actif ? 'badge-warning' : (l.en_tournee ? 'badge-primary' : 'badge-success')}`;
  badge.textContent = !l.actif ? 'INACTIF' : (l.en_tournee ? 'EN TOURNÉE' : 'LIBRE');

  const stats = document.createElement('div');
  stats.className = 'list-meta';
  stats.textContent = `${Number(l.nb_colis_livres || 0)} livrés`;

  right.append(badge, stats);
  row.append(main, right);

  row.addEventListener('click', () => {
    window.location.href = `livreur-detail.html?id=${encodeURIComponent(l.id)}`;
  });

  return row;
}

async function loadLivreurs() {
  const { data, error } = await supabase
    .from('v_livreurs_resume')
    .select('*')
    .order('actif', { ascending: false })
    .order('nom');

  if (error) throw error;

  const rows = data || [];
  const actifs = rows.filter(x => x.actif).length;
  const enTournee = rows.filter(x => x.actif && x.en_tournee).length;
  teamMeta.textContent = `${actifs} actif(s) • ${enTournee} en tournée`;

  livreurList.replaceChildren();
  if (!rows.length) {
    livreurList.appendChild(createEmptyState('Aucun livreur enregistré.'));
    return;
  }

  rows.forEach(l => livreurList.appendChild(makeLivreurRow(l)));
}

async function createLivreur() {
  const nom = newNom.value.trim();
  const telephone = newTel.value.trim();
  const zoneId = newZone.value;
  const pin = newPin.value.trim();

  if (!nom || !zoneId || !/^\d{4}$/.test(pin)) {
    alert('Nom, zone et code PIN de 4 chiffres sont obligatoires.');
    return;
  }

  createLivreurBtn.disabled = true;
  createLivreurBtn.textContent = 'CRÉATION...';

  try {
    const { error } = await supabase.rpc('create_livreur_account', {
      p_nom: nom,
      p_telephone: telephone,
      p_zone_id: zoneId,
      p_pin: pin
    });

    if (error) throw error;

    newNom.value = '';
    newTel.value = '';
    newZone.value = '';
    newPin.value = '';
    createSection.classList.add('hidden');
    await loadLivreurs();
    alert('Livreur créé. Son code PIN est maintenant actif.');
  } catch (err) {
    console.error(err);
    alert(err.message || 'Impossible de créer le livreur.');
  } finally {
    createLivreurBtn.disabled = false;
    createLivreurBtn.textContent = 'CRÉER LE LIVREUR';
  }
}

async function init() {
  const user = await auth.requireRole(['gerant', 'patronne']);
  if (!user) return;

  role = await auth.getCurrentRole();

  if (role === 'gerant') {
    toggleCreateBtn.classList.remove('hidden');
    zonesLink.classList.remove('hidden');
    toggleCreateBtn.addEventListener('click', () => createSection.classList.toggle('hidden'));
    createLivreurBtn.addEventListener('click', createLivreur);
  } else {
    zonesLink.classList.add('hidden');
  }

  try {
    await Promise.all([loadZones(), loadLivreurs()]);
  } catch (err) {
    console.error(err);
    livreurList.replaceChildren(createEmptyState('Erreur de chargement de l’équipe.'));
  }
}

document.addEventListener('DOMContentLoaded', init);
