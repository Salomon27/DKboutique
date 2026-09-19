import { auth } from './auth.js';
import { supabase } from './config.js';

const argentDehors = document.getElementById('argentDehors');
const activeCount = document.getElementById('activeCount');
const colisCount = document.getElementById('colisCount');
const activeList = document.getElementById('activeList');
const closedList = document.getElementById('closedList');
const lastRefresh = document.getElementById('lastRefresh');
const logoutBtn = document.getElementById('logoutBtn');

let realtimeChannel = null;
let refreshTimer = null;

function formatFcfa(value) {
  return `${Number(value || 0).toLocaleString('fr-FR')} F`;
}

function makeTourRow(item, closed = false) {
  const row = document.createElement('div');
  row.className = 'tour-row';

  const left = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'font-bold';
  title.textContent = item.livreur_nom || 'Livreur';

  const meta = document.createElement('div');
  meta.className = 'text-sm text-muted';
  meta.textContent = `${item.zone_nom || 'Sans zone'} • ${Number(item.nb_colis_total || 0)} colis`;

  left.append(title, meta);

  const right = document.createElement('div');
  right.className = 'text-right';

  const amount = document.createElement('div');
  amount.className = 'amount';
  amount.textContent = formatFcfa(closed ? item.montant_final : item.net_a_encaisser);

  const state = document.createElement('div');
  state.className = `badge ${closed ? 'badge-success' : 'badge-primary'}`;
  state.textContent = closed ? 'CLÔTURÉE' : 'EN COURS';

  right.append(amount, state);
  row.append(left, right);
  return row;
}

async function loadDashboard() {
  const [activeRes, closedRes] = await Promise.all([
    supabase
      .from('v_sorties_resume')
      .select('id, livreur_nom, zone_nom, nb_colis_total, net_a_encaisser, statut, created_at')
      .eq('statut', 'en_cours')
      .order('created_at', { ascending: false }),
    supabase
      .from('v_sorties_resume')
      .select('id, livreur_nom, zone_nom, nb_colis_total, montant_final, statut, closed_at')
      .eq('statut', 'cloturee')
      .order('closed_at', { ascending: false })
      .limit(12)
  ]);

  if (activeRes.error) throw activeRes.error;
  if (closedRes.error) throw closedRes.error;

  const active = activeRes.data || [];
  const closed = closedRes.data || [];

  argentDehors.textContent = formatFcfa(
    active.reduce((sum, row) => sum + Number(row.net_a_encaisser || 0), 0)
  );
  activeCount.textContent = String(active.length);
  colisCount.textContent = String(
    active.reduce((sum, row) => sum + Number(row.nb_colis_total || 0), 0)
  );

  activeList.replaceChildren();
  if (!active.length) {
    const empty = document.createElement('p');
    empty.className = 'text-muted text-sm';
    empty.textContent = 'Aucune tournée en cours.';
    activeList.appendChild(empty);
  } else {
    active.forEach(row => activeList.appendChild(makeTourRow(row, false)));
  }

  closedList.replaceChildren();
  if (!closed.length) {
    const empty = document.createElement('p');
    empty.className = 'text-muted text-sm';
    empty.textContent = 'Aucune tournée clôturée.';
    closedList.appendChild(empty);
  } else {
    closed.forEach(row => closedList.appendChild(makeTourRow(row, true)));
  }

  lastRefresh.textContent = new Date().toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadDashboard().catch(err => console.error('Patronne refresh:', err));
  }, 500);
}

function setupRealtime() {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);

  realtimeChannel = supabase
    .channel('patronne-overview')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sorties' }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'colis' }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sortie_operations' }, scheduleRefresh)
    .subscribe();
}

async function init() {
  const user = await auth.requireRole(['patronne']);
  if (!user) return;

  logoutBtn.addEventListener('click', async () => {
    if (realtimeChannel) await supabase.removeChannel(realtimeChannel);
    await auth.logout();
  });

  try {
    await loadDashboard();
    setupRealtime();
  } catch (err) {
    console.error(err);
    activeList.textContent = 'Impossible de charger la supervision.';
  }
}

document.addEventListener('DOMContentLoaded', init);
