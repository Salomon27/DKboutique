import { auth } from './auth.js';
import { supabase } from './config.js';
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
  activeDescription:$('activeDescription'),supervisionError:$('supervisionError'),
  supervisionAlert:$('supervisionAlert')
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

const sum = (rows,key) => rows.reduce((total,row)=> total + Number(row[key]||0),0);

function makeBadge(text,kind='') {
  const badge=document.createElement('span');
  badge.className='dk-flag'+(kind ? ' '+kind : '');
  badge.textContent=text;
  return badge;
}

function makeTourCard(tour,closed=false) {
  const a=document.createElement('a');
  a.className='dk-tour-item';
  a.href=`dossier-detail.html?id=${encodeURIComponent(tour.id)}`;
  a.setAttribute('aria-label',`Consulter le dossier de ${tour.livreur_nom||'livreur'}`);
  const main=document.createElement('div');
  const name=document.createElement('div');name.className='dk-tour-title';
  name.textContent=tour.livreur_nom||'Livreur';
  const meta=document.createElement('div');meta.className='dk-tour-meta';
  const stamp=closed ? tour.closed_at : tour.created_at;
  meta.textContent=`${tour.zone_nom||'Zone non renseignée'} · ${formatDate(stamp,true)} · ${Number(tour.nb_colis_total||0)} colis`;
  const flags=document.createElement('div');flags.className='dk-tour-flags';
  if(closed){
    flags.append(makeBadge('CLÔTURÉE','good'));
    flags.append(makeBadge(`${Number(tour.nb_livres||0)} livrés`));
  }else{
    flags.append(makeBadge(`${Number(tour.nb_livres||0)} livrés`));
    flags.append(makeBadge(`${Number(tour.nb_en_attente||0)} en attente`,Number(tour.nb_en_attente||0)>0?'warn':''));
    if(Number(tour.nb_retour_signale||0)>0)
      flags.append(makeBadge(`${Number(tour.nb_retour_signale)} retours signalés`,'warn'));
    if(Number(tour.nb_retours_confirmes||0)>0)
      flags.append(makeBadge(`${Number(tour.nb_retours_confirmes)} retours confirmés`,'good'));
  }
  main.append(name,meta,flags);

  const right=document.createElement('div');right.className='dk-tour-right';
  const money=document.createElement('strong');money.className='dk-tour-money';
  money.textContent=closed && tour.montant_final!==null ? formatFcfa(tour.montant_final) : formatFcfa(tour.net_a_encaisser);
  const see=document.createElement('span');see.className='dk-section-sub';
  see.textContent='Voir dossier →';
  right.append(money,see);
  a.append(main,right);
  return a;
}

function renderList(target,rows,closed=false) {
  target.replaceChildren();
  if(!rows.length){
    target.appendChild(createEmptyState(closed?'Aucune clôture récente.':'Aucune tournée pour ces filtres.'));
    return;
  }
  const fragment=document.createDocumentFragment();
  rows.forEach(t=>fragment.appendChild(makeTourCard(t,closed)));
  target.appendChild(fragment);
}

function render() {
  elements.argentDehors.textContent=formatFcfa(sum(activeTours,'net_a_encaisser'));
  elements.activeCount.textContent=String(activeTours.length);
  elements.colisCount.textContent=String(sum(activeTours,'nb_colis_total'));
  elements.deliveredCount.textContent=String(sum(activeTours,'nb_livres'));
  elements.returnsSignaled.textContent=String(sum(activeTours,'nb_retour_signale'));
  elements.returnsConfirmed.textContent=String(sum(activeTours,'nb_retours_confirmes'));
  elements.pendingCount.textContent=String(sum(activeTours,'nb_en_attente'));

  const query=elements.searchTour.value.trim().toLocaleLowerCase('fr-FR');
  const zone=elements.zoneTourFilter.value;
  const shown=activeTours.filter(t=> (!zone||t.zone_id===zone)
    && (!query||[t.livreur_nom,t.zone_nom].some(value=>String(value||'').toLocaleLowerCase('fr-FR').includes(query))));
  elements.activeVisibleCount.textContent=`${shown.length} / ${activeTours.length}`;
  elements.activeDescription.textContent='Ouvrir un dossier : photos, déclarations et opérations financières.';
  renderList(elements.activeList,shown);
  renderList(elements.closedList,recentClosed,true);

  const problems=[];
  const waiting=sum(activeTours,'nb_en_attente');
  const reported=sum(activeTours,'nb_retour_signale');
  if(waiting) problems.push(`${waiting} colis en attente de décision.`);
  if(reported) problems.push(`${reported} retour(s) signalé(s) : vérifier leur confirmation dans les dossiers.`);
  if(dataPartial) problems.push('Plus de 2 000 tournées actives : indicateurs partiels. Affinez la supervision.');
  elements.supervisionAlert.classList.toggle('hidden',!problems.length);
  elements.supervisionAlert.classList.toggle('good',!problems.length);
  elements.supervisionAlert.textContent=problems.join(' ');
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
  elements.searchTour.addEventListener('input',render);
  elements.zoneTourFilter.addEventListener('change',render);
  await loadDashboard();
  setupRealtime();
}
document.addEventListener('DOMContentLoaded',init);
