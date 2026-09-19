import { auth } from './auth.js';
import { supabase } from './config.js';
import { enableAutoSync } from './auto-sync.js';
import { formatFcfa, createEmptyState } from './page-utils.js';

const $ = id => document.getElementById(id);
const elements = {
  createSection:$('createSection'), toggleCreateBtn:$('toggleCreateBtn'),
  closeCreateBtn:$('closeCreateBtn'), createLivreurBtn:$('createLivreurBtn'),
  zonesLink:$('zonesLink'), livreurList:$('livreurList'), teamMeta:$('teamMeta'),
  teamResults:$('teamResults'), teamActive:$('teamActive'),
  teamOnTour:$('teamOnTour'), teamAvailable:$('teamAvailable'),
  searchLivreur:$('searchLivreur'), zoneFilter:$('zoneFilter'),
  filters:$('teamFilters'), refreshTeamBtn:$('refreshTeamBtn'), teamError:$('teamError'),
  newNom:$('newNom'), newTel:$('newTel'), newZone:$('newZone'),
  newPin:$('newPin'), feedback:$('teamCreateFeedback')
};
let role = null;
let livreurs = [];
let statusFilter = 'tous';

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0,2).map(p => p.charAt(0).toUpperCase()).join('') || 'DK';
}
function stateOf(l) {
  return !l.actif ? 'inactif' : l.en_tournee ? 'tournee' : 'libre';
}
function stateText(l) {
  return !l.actif ? 'INACTIF' : l.en_tournee ? 'EN TOURNÉE' : 'DISPONIBLE';
}
function setCreateOpen(open) {
  elements.createSection.classList.toggle('hidden', !open);
  elements.toggleCreateBtn.setAttribute('aria-expanded', String(open));
  if (open) elements.newNom.focus();
}
function makeDriverCard(l) {
  const card = document.createElement('a');
  card.className = 'dk-driver-card';
  card.href = `livreur-detail.html?id=${encodeURIComponent(l.id)}`;
  card.setAttribute('aria-label', `Ouvrir la fiche de ${l.nom}`);

  const top = document.createElement('div'); top.className = 'dk-driver-top';
  const avatar = document.createElement('div'); avatar.className = 'dk-driver-avatar'; avatar.textContent = initials(l.nom);
  const main = document.createElement('div'); main.className = 'dk-driver-main';
  const name = document.createElement('div'); name.className = 'dk-driver-name'; name.textContent = l.nom || 'Livreur';
  const zone = document.createElement('div'); zone.className = 'dk-driver-zone'; zone.textContent = l.zone_nom || 'Zone non attribuée';
  main.append(name,zone);
  const state = document.createElement('span');
  state.className = 'dk-driver-status ' + (stateOf(l)==='tournee' ? 'on-tour' : stateOf(l)==='inactif' ? 'off' : '');
  state.textContent = stateText(l);
  top.append(avatar,main,state);

  const detail = document.createElement('div');detail.className = 'dk-driver-detail';
  const phone = document.createElement('span');phone.textContent = l.telephone || 'Téléphone non renseigné';
  const delivered = document.createElement('span');
  delivered.textContent = `${Number(l.nb_colis_livres || 0)} livrés`;
  detail.append(phone,delivered);

  const footer = document.createElement('div');footer.className='dk-driver-footer';
  const tours = document.createElement('span');tours.textContent = `${Number(l.nb_tournees || 0)} tournée(s)`;
  const link = document.createElement('span');link.textContent = 'Voir la fiche →';
  footer.append(tours,link);
  card.append(top,detail,footer);
  return card;
}

function render() {
  const active = livreurs.filter(l=>l.actif);
  const onTour = active.filter(l=>l.en_tournee).length;
  elements.teamActive.textContent = String(active.length);
  elements.teamOnTour.textContent = String(onTour);
  elements.teamAvailable.textContent = String(active.length-onTour);
  elements.teamMeta.textContent = `${livreurs.length} compte(s) · ${onTour} en tournée`;

  const search = elements.searchLivreur.value.trim().toLocaleLowerCase('fr-FR');
  const zone = elements.zoneFilter.value;
  const visible = livreurs.filter(l =>
    (!search || [l.nom,l.telephone,l.zone_nom].some(v => String(v||'').toLocaleLowerCase('fr-FR').includes(search)))
    && (!zone || l.zone_id===zone)
    && (statusFilter==='tous' || statusFilter===stateOf(l))
  );
  elements.teamResults.textContent = `${visible.length} / ${livreurs.length}`;
  elements.livreurList.replaceChildren();
  if (!visible.length) {
    elements.livreurList.appendChild(createEmptyState('Aucun livreur pour ces filtres.'));
  } else {
    const fragment=document.createDocumentFragment();
    visible.forEach(l=>fragment.appendChild(makeDriverCard(l)));
    elements.livreurList.appendChild(fragment);
  }
}

async function loadZones() {
  const {data,error} = await supabase.from('zones').select('id, nom, actif').order('nom');
  if(error) throw error;
  const prior=elements.zoneFilter.value;
  elements.zoneFilter.replaceChildren();
  const all=document.createElement('option');all.value='';all.textContent='Toutes les zones';
  elements.zoneFilter.appendChild(all);
  elements.newZone.replaceChildren();
  const empty=document.createElement('option');empty.value='';empty.textContent='Choisir une zone';
  elements.newZone.appendChild(empty);
  (data||[]).forEach(zone=>{
    const opt=document.createElement('option');opt.value=zone.id;opt.textContent=zone.nom;
    elements.zoneFilter.appendChild(opt);
    if(zone.actif){
      const option=document.createElement('option');option.value=zone.id;option.textContent=zone.nom;
      elements.newZone.appendChild(option);
    }
  });
  elements.zoneFilter.value=prior;
}

async function loadLivreurs({ throwOnError = false } = {}) {
  elements.refreshTeamBtn.disabled=true;
  elements.teamError.classList.add('hidden');
  try {
    const {data,error}=await supabase.from('v_livreurs_resume')
      .select('id, nom, telephone, zone_id, zone_nom, actif, en_tournee, nb_tournees, nb_colis_livres')
      .order('actif',{ascending:false}).order('nom');
    if(error) throw error;
    livreurs=data||[];
    render();
  }catch(error){
    console.error('Chargement de l’équipe:',error);
    elements.teamError.textContent=error?.message||'Chargement impossible. Réessayez.';
    elements.teamError.classList.remove('hidden');
    if(!livreurs.length) elements.livreurList.replaceChildren(createEmptyState('Équipe indisponible.'));
    if (throwOnError) throw error;
  }finally{
    elements.refreshTeamBtn.disabled=false;
  }
}

async function createLivreur() {
  const nom=elements.newNom.value.trim(),telephone=elements.newTel.value.trim();
  const zoneId=elements.newZone.value,pin=elements.newPin.value.trim();
  if(!nom||!zoneId||!/^\d{4}$/.test(pin)) {
    elements.feedback.textContent='Nom, zone et PIN de 4 chiffres obligatoires.';
    return;
  }
  elements.createLivreurBtn.disabled=true;elements.feedback.textContent='Création…';
  try{
    const {error}=await supabase.rpc('create_livreur_account',{
      p_nom:nom,p_telephone:telephone,p_zone_id:zoneId,p_pin:pin
    });
    if(error) throw error;
    [elements.newNom,elements.newTel,elements.newPin].forEach(input=>input.value='');
    elements.newZone.value='';
    setCreateOpen(false);
    elements.feedback.textContent='';
    await loadLivreurs();
  }catch(error){
    console.error('Création livreur:',error);
    elements.feedback.textContent=error?.message||'Création impossible.';
  }finally{elements.createLivreurBtn.disabled=false;}
}

async function init(){
  const user=await auth.requireRole(['gerant','patronne']);
  if(!user)return;
  role=await auth.getCurrentRole();
  if(role==='gerant'){
    elements.toggleCreateBtn.classList.remove('hidden');
    elements.zonesLink.classList.remove('hidden');
    elements.toggleCreateBtn.addEventListener('click',()=>setCreateOpen(elements.createSection.classList.contains('hidden')));
    elements.closeCreateBtn.addEventListener('click',()=>setCreateOpen(false));
    elements.createLivreurBtn.addEventListener('click',createLivreur);
  }
  elements.searchLivreur.addEventListener('input',render);
  elements.zoneFilter.addEventListener('change',render);
  elements.filters.addEventListener('click',event=>{
    const button=event.target.closest('button[data-status]');
    if(!button)return;
    statusFilter=button.dataset.status;
    elements.filters.querySelectorAll('button[data-status]').forEach(item=>{
      const active=item===button;
      item.classList.toggle('active',active);
      item.setAttribute('aria-pressed',String(active));
    });
    render();
  });
  elements.refreshTeamBtn.addEventListener('click',()=>loadLivreurs());
  await Promise.allSettled([loadZones(),loadLivreurs()]);
  enableAutoSync(() => loadLivreurs({ throwOnError: true }), {
    tables: ['livreurs', 'sorties', 'colis'], intervalMs: 30000,
    shouldRefresh: () => elements.createSection.classList.contains('hidden') && !document.activeElement?.matches('input, textarea')
  });
}
document.addEventListener('DOMContentLoaded',init);
