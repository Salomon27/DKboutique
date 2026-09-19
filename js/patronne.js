import { auth } from './auth.js';
import { supabase } from './config.js';
import { enableAutoSync } from './auto-sync.js';
import { formatFcfa, formatDate, createEmptyState } from './page-utils.js';

const $ = id => document.getElementById(id);
const elements = {
  argentDehors:$('argentDehors'), activeCount:$('activeCount'), colisCount:$('colisCount'),
  deliveredCount:$('deliveredCount'), returnsSignaled:$('returnsSignaled'),
  returnsConfirmed:$('returnsConfirmed'), pendingCount:$('pendingCount'),
  activeList:$('activeList'),closedList:$('closedList'),
  lastRefresh:$('lastRefresh'), logoutBtn:$('logoutBtn'),
  refreshSupervision:$('refreshSupervision'),searchTour:$('searchTour'),
  zoneTourFilter:$('zoneTourFilter'),activeVisibleCount:$('activeVisibleCount'),
  supervisionError:$('supervisionError'),supervisionAlert:$('supervisionAlert'),
  activePanel:$('activePanel'),closedPanel:$('closedPanel'),activeTab:$('activeTab'),closedTab:$('closedTab'),
  activeTabCount:$('activeTabCount'),closedTabCount:$('closedTabCount'),activeMoreBtn:$('activeMoreBtn')
};

const PAGE_SIZE = 200;
const MAX_ACTIVE = 2000;
const SELECT_FIELDS = [
  'id','livreur_nom','zone_id','zone_nom','statut','created_at','closed_at',
  'nb_colis_total','nb_livres','nb_retour_signale','nb_retours_confirmes',
  'nb_en_attente','net_a_encaisser','montant_final','montant_chargement',
  'montant_retours','deduction_livraison','frais_divers'
].join(',');

let activeTours = [];
let recentClosed = [];
let realtimeChannel = null;
let refreshTimer = null;
let refreshSerial = 0;
let dataPartial = false;
let loading = false;
let visibleActive = 5;
const expandedTours = new Set();

const sum = (rows,key) => rows.reduce((total,row)=> total + Number(row[key]||0),0);

function infoCell(label, value) {
  const cell = document.createElement('div');
  const caption = document.createElement('span');
  caption.textContent = label;
  const strong = document.createElement('strong');
  strong.textContent = String(value);
  cell.append(caption, strong);
  return cell;
}

function makeTourCard(tour, closed = false) {
  const card = document.createElement('article');
  card.className = 'sup-item';

  const open = document.createElement('button');
  open.className = 'sup-item-toggle';
  open.type = 'button';
  open.setAttribute('aria-expanded', String(expandedTours.has(tour.id)));
  const label = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'sup-item-name';
  name.textContent = tour.livreur_nom || 'Livreur';
  const meta = document.createElement('div');
  meta.className = 'sup-item-meta';
  meta.textContent = `${tour.zone_nom || 'Zone non renseignée'} · ${Number(tour.nb_colis_total || 0)} colis`;
  label.append(name, meta);
  const right = document.createElement('div');
  right.className = 'sup-item-right';
  const amount = document.createElement('strong');
  amount.className = 'sup-item-amount';
  amount.textContent = closed
    ? (tour.montant_final === null ? 'Net non figé' : formatFcfa(tour.montant_final))
    : formatFcfa(tour.net_a_encaisser);
  const more = document.createElement('span');
  more.className = 'sup-item-more';
  more.textContent = 'Détails ＋';
  right.append(amount, more);
  open.append(label, right);

  const detail = document.createElement('div');
  detail.className = 'sup-item-detail';
  const detailId = `supervision-${tour.id}`;
  detail.id = detailId;
  open.setAttribute('aria-controls', detailId);
  if (!expandedTours.has(tour.id)) detail.classList.add('hidden');
  else more.textContent = 'Réduire −';

  const status = document.createElement('div');
  status.className = 'sup-item-status';
  status.textContent = closed
    ? `CLÔTURÉE · ${formatDate(tour.closed_at, true)}`
    : `EN COURS · ${formatDate(tour.created_at, true)}`;

  const grid = document.createElement('div');
  grid.className = 'sup-item-data';
  grid.append(
    infoCell('Livrés déclarés', Number(tour.nb_livres || 0)),
    infoCell('En attente', Number(tour.nb_en_attente || 0)),
    infoCell('Retours signalés', Number(tour.nb_retour_signale || 0)),
    infoCell('Retours confirmés', Number(tour.nb_retours_confirmes || 0)),
    infoCell('Chargement', formatFcfa(tour.montant_chargement)),
    infoCell('Retours confirmés (montant)', formatFcfa(tour.montant_retours)),
    infoCell('Déductions + frais', formatFcfa(Number(tour.deduction_livraison || 0) + Number(tour.frais_divers || 0))),
    infoCell(closed ? 'Net figé à la clôture' : 'Net théorique actuel',
      closed && tour.montant_final !== null ? formatFcfa(tour.montant_final) : formatFcfa(tour.net_a_encaisser))
  );

  const dossier = document.createElement('a');
  dossier.className = 'btn btn-outline';
  dossier.href = `dossier-detail.html?id=${encodeURIComponent(tour.id)}`;
  dossier.textContent = 'Ouvrir le dossier · photos et opérations →';
  detail.append(status, grid, dossier);

  open.addEventListener('click', () => {
    const expand = open.getAttribute('aria-expanded') !== 'true';
    open.setAttribute('aria-expanded', String(expand));
    detail.classList.toggle('hidden', !expand);
    more.textContent = expand ? 'Réduire −' : 'Détails ＋';
    if (expand) expandedTours.add(tour.id);
    else expandedTours.delete(tour.id);
  });
  card.append(open, detail);
  return card;
}

function renderList(target, rows, closed = false) {
  target.replaceChildren();
  if (!rows.length) {
    target.appendChild(createEmptyState(closed
      ? 'Aucune clôture récente.' : 'Aucune tournée pour ces filtres.'));
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach(tour => fragment.appendChild(makeTourCard(tour, closed)));
  target.appendChild(fragment);
}

function render() {
  elements.argentDehors.textContent = formatFcfa(sum(activeTours, 'net_a_encaisser'));
  elements.activeCount.textContent = String(activeTours.length);
  elements.colisCount.textContent = String(sum(activeTours, 'nb_colis_total'));
  elements.deliveredCount.textContent = String(sum(activeTours, 'nb_livres'));
  elements.returnsSignaled.textContent = String(sum(activeTours, 'nb_retour_signale'));
  elements.returnsConfirmed.textContent = String(sum(activeTours, 'nb_retours_confirmes'));
  elements.pendingCount.textContent = String(sum(activeTours, 'nb_en_attente'));
  elements.activeTabCount.textContent = String(activeTours.length);
  elements.closedTabCount.textContent = String(recentClosed.length);

  const query = elements.searchTour.value.trim().toLocaleLowerCase('fr-FR');
  const zone = elements.zoneTourFilter.value;
  const shown = activeTours.filter(tour => (!zone || tour.zone_id === zone)
    && (!query || [tour.livreur_nom, tour.zone_nom].some(value =>
      String(value || '').toLocaleLowerCase('fr-FR').includes(query))));

  elements.activeVisibleCount.textContent = `${shown.length} tournée(s)`;
  renderList(elements.activeList, shown.slice(0, visibleActive));
  elements.activeMoreBtn.classList.toggle('hidden', shown.length <= visibleActive);
  elements.activeMoreBtn.textContent = `Voir davantage · ${shown.length - visibleActive} restantes`;
  renderList(elements.closedList, recentClosed, true);

  const waiting = sum(activeTours, 'nb_en_attente');
  const partial = dataPartial;
  elements.supervisionAlert.classList.toggle('hidden', !waiting && !partial);
  elements.supervisionAlert.textContent = [
    waiting ? `${waiting} colis en attente · ouvrir une tournée pour les vérifier.` : '',
    partial ? 'Données partielles : plus de 2 000 tournées en cours.' : ''
  ].filter(Boolean).join(' ');
}

function selectTab(closed) {
  elements.activePanel.classList.toggle('hidden', closed);
  elements.closedPanel.classList.toggle('hidden', !closed);
  elements.activeTab.classList.toggle('active', !closed);
  elements.closedTab.classList.toggle('active', closed);
  elements.activeTab.setAttribute('aria-selected', String(!closed));
  elements.closedTab.setAttribute('aria-selected', String(closed));
}

function populateZones() {
  const previous=elements.zoneTourFilter.value;
  const zones=new Map();
  activeTours.forEach(t=>{if(t.zone_id)zones.set(t.zone_id,t.zone_nom||'Zone');});
  elements.zoneTourFilter.replaceChildren();
  const all=document.createElement('option');all.value='';all.textContent='Toutes les zones';
  elements.zoneTourFilter.appendChild(all);
  [...zones.entries()].sort((a,b)=>a[1].localeCompare(b[1],'fr-FR')).forEach(([id,name])=>{
    const option=document.createElement('option');option.value=id;option.textContent=name;
    elements.zoneTourFilter.appendChild(option);
  });
  elements.zoneTourFilter.value=zones.has(previous)?previous:'';
}

async function fetchActiveTours() {
  const found=[];
  for(let start=0;start<MAX_ACTIVE;start+=PAGE_SIZE){
    const {data,error}=await supabase.from('v_sorties_resume').select(SELECT_FIELDS)
      .eq('statut','en_cours')
      .order('created_at',{ascending:false})
      .order('id',{ascending:false})
      .range(start,start+PAGE_SIZE-1);
    if(error)throw error;
    found.push(...(data||[]));
    if(!data||data.length<PAGE_SIZE)return {found,partial:false};
  }
  // Do not show partial figures as if they represented every active tour.
  return {found,partial:true};
}

async function loadDashboard() {
  if(loading)return;
  loading=true;
  elements.refreshSupervision.disabled=true;
  elements.supervisionError.classList.add('hidden');
  const ticket=++refreshSerial;
  try {
    const [activeResult,closedResult]=await Promise.all([
      fetchActiveTours(),
      supabase.from('v_sorties_resume').select(SELECT_FIELDS)
        .eq('statut','cloturee')
        .order('closed_at',{ascending:false})
        .limit(12)
    ]);
    if(ticket!==refreshSerial)return;
    if(closedResult.error)throw closedResult.error;
    activeTours=activeResult.found;
    dataPartial=activeResult.partial;
    recentClosed=closedResult.data||[];
    populateZones();
    render();
    elements.lastRefresh.textContent='Mis à jour à '+new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
  }catch(error){
    console.error('Supervision:',error);
    elements.supervisionError.textContent=`Chargement impossible : ${error?.message||'vérifier votre connexion.'}`;
    elements.supervisionError.classList.remove('hidden');
    elements.lastRefresh.textContent='Actualisation échouée';
    throw error;
  }finally{
    if(ticket===refreshSerial){
      loading=false;
      elements.refreshSupervision.disabled=false;
    }
  }
}

function scheduleRefresh(){
  clearTimeout(refreshTimer);
  refreshTimer=setTimeout(()=>loadDashboard().catch(error=>console.error('Actualisation:',error)),700);
}
function setupRealtime(){
  if(realtimeChannel)supabase.removeChannel(realtimeChannel);
  realtimeChannel=supabase.channel('direction-summary-v2')
    .on('postgres_changes',{event:'*',schema:'public',table:'sorties'},scheduleRefresh)
    .on('postgres_changes',{event:'*',schema:'public',table:'colis'},scheduleRefresh)
    .on('postgres_changes',{event:'*',schema:'public',table:'sortie_operations'},scheduleRefresh)
    .subscribe();
}

async function init(){
  const user=await auth.requireRole(['patronne']);
  if(!user)return;
  elements.logoutBtn.addEventListener('click',async()=>{
    clearTimeout(refreshTimer);
    if(realtimeChannel)await supabase.removeChannel(realtimeChannel);
    await auth.logout();
  });
  elements.refreshSupervision.addEventListener('click',()=>loadDashboard());
  elements.searchTour.addEventListener('input', () => {
    visibleActive = 5;
    render();
  });
  elements.zoneTourFilter.addEventListener('change', () => {
    visibleActive = 5;
    render();
  });
  elements.activeMoreBtn.addEventListener('click', () => {
    visibleActive += 10;
    render();
  });
  elements.activeTab.addEventListener('click', () => selectTab(false));
  elements.closedTab.addEventListener('click', () => selectTab(true));
  try { await loadDashboard(); }
  catch(error) { console.error('Premier chargement supervision:', error); }
  setupRealtime();
  enableAutoSync(() => loadDashboard(), { intervalMs: 30000, shouldRefresh: () => !document.querySelector('.dk-nav-backdrop.open') });
}
document.addEventListener('DOMContentLoaded',init);
