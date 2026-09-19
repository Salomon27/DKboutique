import { auth } from './auth.js';
import { supabase } from './config.js';
import { enableAutoSync } from './auto-sync.js';

const logoutBtn = document.getElementById('logoutBtn');
const loader = document.getElementById('loader');
const noTourneeState = document.getElementById('noTourneeState');
const activeTourneeState = document.getElementById('activeTourneeState');
const driverAvatar = document.getElementById('driverAvatar');
const driverName = document.getElementById('driverName');
const driverMeta = document.getElementById('driverMeta');
const zoneName = document.getElementById('zoneName');
const totalVerser = document.getElementById('totalVerser');
const totalCount = document.getElementById('totalCount');
const deliveredCount = document.getElementById('deliveredCount');
const returnCount = document.getElementById('returnCount');
const progressText = document.getElementById('progressText');
const progressFill = document.getElementById('progressFill');
const colisList = document.getElementById('colisList');
const fullscreenViewer = document.getElementById('fullscreenViewer');
const fullscreenImg = document.getElementById('fullscreenImg');
const offlineBanner = document.getElementById('offlineBanner');
const toastContainer = document.getElementById('toastContainer');

let currentLivreurId = null;
let currentSortieId = null;
let currentZoneName = '';
let isOffline = !navigator.onLine;

const signedUrlCache = new Map();
let colisSubscription = null;
let livreurSortiesSubscription = null;
let realtimeRefreshTimer = null;

function formatFcfa(value) {
    return `${Number(value || 0).toLocaleString('fr-FR')} F`;
}

function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '--';
    return parts.slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
}

async function init() {
    const user = await auth.requireRole(['livreur']);
    if (!user) return;

    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);
    updateNetworkStatus();

    logoutBtn.addEventListener('click', async () => {
        cleanupRealtime();
        await auth.logout();
    });

    fullscreenViewer.addEventListener('click', closeFullscreen);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeFullscreen();
    });

    await loadProfileAndApp();
    if (currentLivreurId) enableAutoSync(() => loadActiveSortie(), {
      intervalMs: 30000,
      shouldRefresh: () => !document.querySelector('.action-btn:disabled')
        && fullscreenViewer.style.display !== 'flex'
    });
}

function updateNetworkStatus() {
    isOffline = !navigator.onLine;
    offlineBanner.style.display = isOffline ? 'block' : 'none';

    // Le module commun reprend automatiquement la lecture après reconnexion.
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);

    gsap.to(toast, { opacity: 1, y: -6, duration: 0.25 });
    setTimeout(() => {
        gsap.to(toast, {
            opacity: 0,
            y: 6,
            duration: 0.25,
            onComplete: () => toast.remove()
        });
    }, 2600);
}

async function loadProfileAndApp() {
    try {
        currentLivreurId = await auth.getCurrentLivreurId();
        if (!currentLivreurId) throw new Error('Session livreur introuvable.');

        const { data: livreur, error } = await supabase
            .from('livreurs')
            .select('id, nom, telephone, actif, zones(nom)')
            .eq('id', currentLivreurId)
            .single();

        if (error) throw error;
        if (!livreur || !livreur.actif) throw new Error('Compte livreur indisponible.');

        currentZoneName = livreur.zones?.nom || 'Zone non définie';
        driverName.textContent = livreur.nom || 'Livreur';
        driverAvatar.textContent = initials(livreur.nom);
        driverMeta.textContent = currentZoneName + (livreur.telephone ? ` • ${livreur.telephone}` : '');
        zoneName.textContent = currentZoneName;

        setupLivreurRealtime();
        await loadActiveSortie();
    } catch (err) {
        console.error(err);
        loader.replaceChildren();
        const message = document.createElement('p');
        message.className = 'text-muted text-sm';
        message.textContent = 'Impossible de charger votre profil.';
        loader.appendChild(message);
    }
}

async function loadActiveSortie() {
    loader.classList.remove('hidden');
    noTourneeState.classList.add('hidden');
    activeTourneeState.classList.add('hidden');

    try {
        const { data: sortie, error } = await supabase
            .from('sorties')
            .select('id, statut')
            .eq('livreur_id', currentLivreurId)
            .eq('statut', 'en_cours')
            .maybeSingle();

        if (error) throw error;

        if (!sortie) {
            currentSortieId = null;
            cleanupColisRealtime();
            colisList.replaceChildren();
            resetSummary();
            loader.classList.add('hidden');
            noTourneeState.classList.remove('hidden');
            return;
        }

        const changedTour = currentSortieId !== sortie.id;
        currentSortieId = sortie.id;

        await Promise.all([
            loadSortieSummary(),
            loadColis()
        ]);

        if (changedTour || !colisSubscription) {
            setupColisRealtime();
        }

        loader.classList.add('hidden');
        activeTourneeState.classList.remove('hidden');
    } catch (err) {
        console.error(err);
        loader.replaceChildren();
        const message = document.createElement('p');
        message.className = 'text-muted text-sm';
        message.textContent = 'Erreur réseau ou base de données.';
        loader.appendChild(message);
    }
}

function resetSummary() {
    totalVerser.textContent = '0 F';
    totalCount.textContent = '0';
    deliveredCount.textContent = '0';
    returnCount.textContent = '0';
    progressText.textContent = '0 / 0 traités';
    progressFill.style.width = '0%';
}

async function loadSortieSummary() {
    if (!currentSortieId) return;

    const { data, error } = await supabase
        .from('v_sorties_resume')
        .select('zone_nom, net_a_encaisser, nb_colis_total, nb_livres, nb_retour_signale')
        .eq('id', currentSortieId)
        .maybeSingle();

    if (error) throw error;
    if (!data) return;

    zoneName.textContent = data.zone_nom || currentZoneName;
    totalVerser.textContent = formatFcfa(data.net_a_encaisser);

    const total = Number(data.nb_colis_total || 0);
    const delivered = Number(data.nb_livres || 0);
    const returned = Number(data.nb_retour_signale || 0);
    const processed = delivered + returned;
    const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

    totalCount.textContent = String(total);
    deliveredCount.textContent = String(delivered);
    returnCount.textContent = String(returned);
    progressText.textContent = `${processed} / ${total} traités`;
    progressFill.style.width = `${percent}%`;
}

async function loadColis() {
    if (!currentSortieId) return;

    const { data, error } = await supabase
        .from('colis')
        .select('id, valeur, commentaire, photo_path, statut_livreur, source, created_at')
        .eq('sortie_id', currentSortieId)
        .order('created_at', { ascending: true });

    if (error) throw error;

    colisList.replaceChildren();

    const rows = data || [];
    if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'card text-center text-muted text-sm';
        empty.textContent = 'Aucun colis dans cette tournée.';
        colisList.appendChild(empty);
        return;
    }

    for (let index = 0; index < rows.length; index++) {
        await renderColisCard(rows[index], index + 1);
    }
}

async function getSignedUrl(photoPath) {
    if (!photoPath) return null;

    const now = Date.now();
    const margin = 5 * 60 * 1000;
    const cached = signedUrlCache.get(photoPath);

    if (cached && now < cached.expiresAt - margin) {
        return cached.url;
    }

    const expiresInSeconds = 24 * 60 * 60;
    const { data, error } = await supabase.storage
        .from('colis-photos')
        .createSignedUrl(photoPath, expiresInSeconds);

    if (error || !data?.signedUrl) {
        console.error('Signed URL error:', error);
        return null;
    }

    signedUrlCache.set(photoPath, {
        url: data.signedUrl,
        expiresAt: now + expiresInSeconds * 1000
    });

    return data.signedUrl;
}

async function renderColisCard(colis, number, animate = false) {
    let card = document.getElementById(`card-${colis.id}`);
    const isNew = !card;

    if (!card) {
        card = document.createElement('article');
        card.id = `card-${colis.id}`;
        card.className = 'card colis-card';
        colisList.appendChild(card);
    }

    card.dataset.status = colis.statut_livreur || 'en_attente';

    const head = document.createElement('div');
    head.className = 'parcel-head';

    const numberEl = document.createElement('span');
    numberEl.className = 'parcel-number';
    numberEl.textContent = `COLIS N° ${number}`;

    const sourceEl = document.createElement('span');
    sourceEl.className = 'parcel-source';
    sourceEl.textContent = colis.source === 'ajout' ? 'AJOUT' : 'INITIAL';

    head.append(numberEl, sourceEl);

    const photo = document.createElement('div');
    photo.className = 'photo-container';

    const photoUrl = await getSignedUrl(colis.photo_path);
    if (photoUrl) {
        const img = document.createElement('img');
        img.src = photoUrl;
        img.alt = `Photo colis ${number}`;
        img.loading = 'lazy';
        img.addEventListener('click', () => openFullscreen(photoUrl));
        photo.appendChild(img);
    } else {
        const unavailable = document.createElement('div');
        unavailable.className = 'photo-unavailable';
        unavailable.textContent = 'Photo indisponible';
        photo.appendChild(unavailable);
    }

    const info = document.createElement('div');
    info.className = 'colis-info';

    const valueRow = document.createElement('div');
    valueRow.className = 'parcel-value-row';

    const value = document.createElement('div');
    value.className = 'parcel-value';
    const isPaid = Number(colis.valeur) === 0;
    value.textContent = isPaid ? 'PAYÉ' : formatFcfa(colis.valeur);
    if (isPaid) value.style.color = 'var(--success)';

    const badge = document.createElement('span');
    badge.id = `badge-${colis.id}`;

    valueRow.append(value, badge);
    info.appendChild(valueRow);

    if (colis.commentaire) {
        const note = document.createElement('div');
        note.className = 'parcel-note';
        note.textContent = colis.commentaire;
        info.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'parcel-actions';

    const btnLivre = document.createElement('button');
    btnLivre.id = `btn-livre-${colis.id}`;
    btnLivre.className = 'btn btn-outline action-btn';
    btnLivre.addEventListener('click', () => handleAction(colis.id, 'livre'));

    const btnRetour = document.createElement('button');
    btnRetour.id = `btn-retour-${colis.id}`;
    btnRetour.className = 'btn btn-outline action-btn';
    btnRetour.addEventListener('click', () => handleAction(colis.id, 'retourne'));

    actions.append(btnLivre, btnRetour);
    info.appendChild(actions);

    card.replaceChildren(head, photo, info);
    updateCardState(colis.id, colis.statut_livreur || 'en_attente');

    if (isNew && animate) {
        gsap.fromTo(card, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: .28, ease: 'power2.out' });
    }
}

function updateCardState(id, statut) {
    const card = document.getElementById(`card-${id}`);
    if (!card) return;

    const btnLivre = document.getElementById(`btn-livre-${id}`);
    const btnRetour = document.getElementById(`btn-retour-${id}`);
    const badge = document.getElementById(`badge-${id}`);

    card.dataset.status = statut;
    card.classList.remove('statut-livre', 'statut-retourne');

    btnLivre.className = 'btn btn-outline action-btn';
    btnRetour.className = 'btn btn-outline action-btn';
    btnLivre.textContent = 'LIVRÉ';
    btnRetour.textContent = 'RETOUR';

    badge.className = 'badge badge-warning';
    badge.textContent = 'EN ATTENTE';

    if (statut === 'livre') {
        card.classList.add('statut-livre');
        btnLivre.className = 'btn btn-success action-btn';
        btnLivre.textContent = 'ANNULER LIVRÉ';
        badge.className = 'badge badge-success';
        badge.textContent = 'LIVRÉ';
    } else if (statut === 'retourne') {
        card.classList.add('statut-retourne');
        btnRetour.className = 'btn btn-danger action-btn';
        btnRetour.textContent = 'ANNULER RETOUR';
        badge.className = 'badge badge-danger';
        badge.textContent = 'RETOUR';
    }
}

async function handleAction(colisId, requestedAction) {
    if (isOffline) {
        showToast('Connexion Internet nécessaire.');
        return;
    }

    const card = document.getElementById(`card-${colisId}`);
    if (!card) return;

    const currentStatut = card.dataset.status || 'en_attente';
    const newStatut = currentStatut === requestedAction ? 'en_attente' : requestedAction;

    if (newStatut === 'retourne') {
        const confirmed = window.confirm('Déclarer ce colis en RETOUR ? Le Gérant devra ensuite confirmer le retour dans Le Point.');
        if (!confirmed) return;
    }

    const btnLivre = document.getElementById(`btn-livre-${colisId}`);
    const btnRetour = document.getElementById(`btn-retour-${colisId}`);
    btnLivre.disabled = true;
    btnRetour.disabled = true;

    try {
        const { error } = await supabase.rpc('update_livreur_colis_status', {
            p_colis_id: colisId,
            p_statut: newStatut
        });

        if (error) throw error;

        updateCardState(colisId, newStatut);
        await loadSortieSummary();

        if (newStatut === 'livre') showToast('Colis marqué LIVRÉ.');
        if (newStatut === 'retourne') showToast('Retour signalé au Gérant.');
        if (newStatut === 'en_attente') showToast('Statut annulé.');
    } catch (err) {
        console.error(err);
        showToast('Impossible de mettre à jour ce colis.');
    } finally {
        btnLivre.disabled = false;
        btnRetour.disabled = false;
    }
}

function setupLivreurRealtime() {
    if (!currentLivreurId) return;

    if (livreurSortiesSubscription) {
        supabase.removeChannel(livreurSortiesSubscription);
    }

    livreurSortiesSubscription = supabase
        .channel(`livreur-sorties-${currentLivreurId}`)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'sorties',
                filter: `livreur_id=eq.${currentLivreurId}`
            },
            (payload) => {
                if (payload.eventType === 'INSERT') {
                    showToast('Nouvelle tournée disponible.');
                } else if (payload.eventType === 'UPDATE' && payload.new?.statut === 'cloturee') {
                    showToast('Votre tournée vient d’être clôturée.');
                }
                scheduleFullRefresh(350);
            }
        )
        .subscribe();
}

function setupColisRealtime() {
    cleanupColisRealtime();
    if (!currentSortieId) return;

    colisSubscription = supabase
        .channel(`colis-livreur-${currentSortieId}`)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'colis',
                filter: `sortie_id=eq.${currentSortieId}`
            },
            (payload) => {
                if (payload.eventType === 'INSERT') {
                    showToast('Nouveau colis ajouté à votre tournée.');
                }
                scheduleFullRefresh(250);
            }
        )
        .subscribe();
}

function scheduleFullRefresh(delay = 250) {
    clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = setTimeout(async () => {
        try {
            await loadActiveSortie();
        } catch (err) {
            console.error('Realtime refresh error:', err);
        }
    }, delay);
}

function cleanupColisRealtime() {
    if (colisSubscription) {
        supabase.removeChannel(colisSubscription);
        colisSubscription = null;
    }
}

function cleanupRealtime() {
    cleanupColisRealtime();

    if (livreurSortiesSubscription) {
        supabase.removeChannel(livreurSortiesSubscription);
        livreurSortiesSubscription = null;
    }

    clearTimeout(realtimeRefreshTimer);
}

function openFullscreen(src) {
    if (!src) return;
    fullscreenImg.src = src;
    fullscreenViewer.style.display = 'flex';
    gsap.to(fullscreenViewer, { opacity: 1, duration: .18 });
}

function closeFullscreen() {
    if (fullscreenViewer.style.display === 'none') return;
    gsap.to(fullscreenViewer, {
        opacity: 0,
        duration: .18,
        onComplete: () => {
            fullscreenViewer.style.display = 'none';
            fullscreenImg.src = '';
        }
    });
}

document.addEventListener('DOMContentLoaded', init);
