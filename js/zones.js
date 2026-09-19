import { auth } from './auth.js';
import { supabase } from './config.js';
import { enableAutoSync } from './auto-sync.js';
import { createEmptyState } from './page-utils.js';

const zoneName = document.getElementById('zoneName');
const addZoneBtn = document.getElementById('addZoneBtn');
const zoneList = document.getElementById('zoneList');

async function loadZones() {
  const { data, error } = await supabase
    .from('zones')
    .select('id, nom, actif, created_at')
    .order('actif', { ascending: false })
    .order('nom');

  if (error) throw error;

  zoneList.replaceChildren();
  if (!data?.length) {
    zoneList.appendChild(createEmptyState('Aucune zone.'));
    return;
  }

  data.forEach(zone => {
    const row = document.createElement('div');
    row.className = 'list-row';

    const main = document.createElement('div');
    main.className = 'list-main';

    const input = document.createElement('input');
    input.className = 'form-control';
    input.value = zone.nom;

    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.textContent = zone.actif ? 'Zone active' : 'Zone inactive';

    main.append(input, meta);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '.4rem';

    const save = document.createElement('button');
    save.className = 'btn btn-outline small-action';
    save.textContent = 'Enregistrer';

    const toggle = document.createElement('button');
    toggle.className = 'btn btn-outline small-action';
    toggle.textContent = zone.actif ? 'Désactiver' : 'Activer';

    save.addEventListener('click', async () => {
      const nom = input.value.trim();
      if (!nom) return alert('Nom requis.');
      const { error } = await supabase.rpc('update_zone', {
        p_zone_id: zone.id,
        p_nom: nom,
        p_actif: zone.actif
      });
      if (error) return alert(error.message);
      await loadZones();
    });

    toggle.addEventListener('click', async () => {
      const { error } = await supabase.rpc('update_zone', {
        p_zone_id: zone.id,
        p_nom: input.value.trim() || zone.nom,
        p_actif: !zone.actif
      });
      if (error) return alert(error.message);
      await loadZones();
    });

    actions.append(save, toggle);
    row.append(main, actions);
    zoneList.appendChild(row);
  });
}

async function addZone() {
  const nom = zoneName.value.trim();
  if (!nom) return alert('Nom de zone requis.');

  addZoneBtn.disabled = true;
  try {
    const { error } = await supabase.rpc('create_zone', { p_nom: nom });
    if (error) throw error;
    zoneName.value = '';
    await loadZones();
  } catch (err) {
    alert(err.message || 'Impossible d’ajouter la zone.');
  } finally {
    addZoneBtn.disabled = false;
  }
}

async function init() {
  const user = await auth.requireRole(['gerant']);
  if (!user) return;
  addZoneBtn.addEventListener('click', addZone);
  // Never overwrite names typed into the zone editor while refreshing.
  enableAutoSync(() => loadZones(), {
    tables: ['zones'], intervalMs: 60000,
    shouldRefresh: () => !zoneName.value.trim() && !document.activeElement?.matches('input, textarea, select')
      && [...zoneList.querySelectorAll('input')].every(field => field.value === field.defaultValue)
  });
  try { await loadZones(); }
  catch (err) {
    console.error(err);
    zoneList.replaceChildren(createEmptyState('Erreur de chargement.'));
  }
}

document.addEventListener('DOMContentLoaded', init);
