import { auth } from './auth.js';
import { supabase } from './config.js';
import { formatFcfa, createEmptyState } from './page-utils.js';

const dayInput = document.getElementById('dayInput');
const todayBtn = document.getElementById('todayBtn');
const totalLoad = document.getElementById('totalLoad');
const totalReturns = document.getElementById('totalReturns');
const totalFees = document.getElementById('totalFees');
const totalNet = document.getElementById('totalNet');
const tourCount = document.getElementById('tourCount');
const parcelCount = document.getElementById('parcelCount');
const deliveredCount = document.getElementById('deliveredCount');
const returnCount = document.getElementById('returnCount');
const breakdownList = document.getElementById('breakdownList');

function todayLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0,10);
}

function dayBounds(value) {
  const start = new Date(`${value}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.toISOString(), end.toISOString()];
}

async function loadDay() {
  const value = dayInput.value;
  if (!value) return;

  const [start, end] = dayBounds(value);

  const role = await auth.getCurrentRole();
  let query = supabase
    .from('v_sorties_resume')
    .select('*')
    .eq('statut', 'cloturee')
    .gte('closed_at', start)
    .lt('closed_at', end)
    .order('closed_at');

  if (role === 'gerant') {
    const profileId = await auth.getCurrentProfileId();
    if (profileId) query = query.eq('gerant_id', profileId);
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows = data || [];

  totalLoad.textContent = formatFcfa(rows.reduce((s,r) => s + Number(r.montant_chargement || 0), 0));
  totalReturns.textContent = formatFcfa(rows.reduce((s,r) => s + Number(r.montant_retours || 0), 0));
  totalFees.textContent = formatFcfa(rows.reduce((s,r) => s + Number(r.deduction_livraison || 0) + Number(r.frais_divers || 0), 0));
  totalNet.textContent = formatFcfa(rows.reduce((s,r) => s + Number(r.montant_final || 0), 0));

  tourCount.textContent = String(rows.length);
  parcelCount.textContent = String(rows.reduce((s,r) => s + Number(r.nb_colis_final ?? r.nb_colis_total ?? 0), 0));
  deliveredCount.textContent = String(rows.reduce((s,r) => s + Number(r.nb_livres || 0), 0));
  returnCount.textContent = String(rows.reduce((s,r) => s + Number(r.nb_retours_confirmes || 0), 0));

  const byLivreur = new Map();
  rows.forEach(r => {
    const key = r.livreur_id;
    if (!byLivreur.has(key)) {
      byLivreur.set(key, {
        nom: r.livreur_nom,
        tours: 0,
        colis: 0,
        net: 0,
        retours: 0
      });
    }
    const item = byLivreur.get(key);
    item.tours += 1;
    item.colis += Number(r.nb_colis_final ?? r.nb_colis_total ?? 0);
    item.net += Number(r.montant_final || 0);
    item.retours += Number(r.montant_retours || 0);
  });

  breakdownList.replaceChildren();
  const items = [...byLivreur.values()].sort((a,b) => a.nom.localeCompare(b.nom));

  if (!items.length) {
    breakdownList.appendChild(createEmptyState('Aucune clôture pour cette journée.'));
    return;
  }

  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'list-row';

    const main = document.createElement('div');
    main.className = 'list-main';

    const title = document.createElement('div');
    title.className = 'list-title';
    title.textContent = item.nom;

    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.textContent = `${item.tours} tournée(s) • ${item.colis} colis • Retours ${formatFcfa(item.retours)}`;

    main.append(title, meta);

    const amount = document.createElement('div');
    amount.className = 'list-amount';
    amount.textContent = formatFcfa(item.net);

    row.append(main, amount);
    breakdownList.appendChild(row);
  });
}

async function init() {
  const user = await auth.requireRole(['gerant', 'patronne']);
  if (!user) return;

  dayInput.value = todayLocal();
  dayInput.addEventListener('change', () => loadDay().catch(console.error));
  todayBtn.addEventListener('click', () => {
    dayInput.value = todayLocal();
    loadDay().catch(console.error);
  });

  try { await loadDay(); }
  catch (err) {
    console.error(err);
    breakdownList.replaceChildren(createEmptyState('Impossible de charger le bilan.'));
  }
}

document.addEventListener('DOMContentLoaded', init);
