import { auth } from './auth.js';
import { supabase } from './config.js';

// DOM
const logoutBtn = document.getElementById('logoutBtn');
const loader = document.getElementById('loader');
const noTourneeState = document.getElementById('noTourneeState');
const activeTourneeState = document.getElementById('activeTourneeState');
const zoneName = document.getElementById('zoneName');
const totalVerser = document.getElementById('totalVerser');
const progressText = document.getElementById('progressText');
const colisList = document.getElementById('colisList');
const fullscreenViewer = document.getElementById('fullscreenViewer');
const fullscreenImg = document.getElementById('fullscreenImg');
const offlineBanner = document.getElementById('offlineBanner');
const toastContainer = document.getElementById('toastContainer');

// State
let currentUser = null;
let currentLivreurId = null;
let currentSortieId = null;
let isOffline = !navigator.onLine;

// Cache Signed URLs
// Map<photo_path, { url: string, expiresAt: number }>
const signedUrlCache = new Map();

// Realtime
let colisSubscription = null;
let sortieSubscription = null;

async function init() {
    currentUser = await auth.requireRole(['livreur']);
    if (!currentUser) return;

    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);
    updateNetworkStatus();

    logoutBtn.addEventListener('click', async () => {
        cleanupRealtime();
        await auth.logout();
    });

    fullscreenViewer.addEventListener('click', () => {
        gsap.to(fullscreenViewer, { opacity: 0, duration: 0.2, onComplete: () => fullscreenViewer.style.display = 'none' });
    });

    await loadApp();
}

function updateNetworkStatus() {
    isOffline = !navigator.onLine;
    if (isOffline) {
        offlineBanner.style.display = 'block';
    } else {
        offlineBanner.style.display = 'none';
    }
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    
    gsap.to(toast, { opacity: 1, y: -10, duration: 0.3 });
    setTimeout(() => {
        gsap.to(toast, { opacity: 0, y: 10, duration: 0.3, onComplete: () => toast.remove() });
    }, 3000);
}

async function loadApp() {
    try {
        currentLivreurId = await auth.getCurrentLivreurId();
        if (!currentLivreurId) throw new Error("Session livreur introuvable.");

        const { data: livreur, error } = await supabase
            .from('livreurs')
            .select('id, zones(nom)')
            .eq('id', currentLivreurId)
            .single();

        if (error) throw error;
        if (!livreur) throw new Error("Profil livreur non trouvé.");

        zoneName.textContent = livreur.zones?.nom || 'Zone inconnue';

        await loadActiveSortie();
    } catch (err) {
        console.error(err);
        loader.innerHTML = `<p class="text-danger" style="text-align:center;">Erreur: Impossible de charger votre profil.</p>`;
    }
}

async function loadActiveSortie() {
    try {
        loader.classList.remove('hidden');
        noTourneeState.classList.add('hidden');
        activeTourneeState.classList.add('hidden');

        const { data: sortie, error } = await supabase
            .from('sorties')
            .select('id, statut')
            .eq('livreur_id', currentLivreurId)
            .eq('statut', 'en_cours')
            .maybeSingle();

        if (error) throw error;

        if (!sortie) {
            loader.classList.add('hidden');
            noTourneeState.classList.remove('hidden');
            cleanupRealtime(); // Au cas où on venait d'une tournée qui vient de clore
            return;
        }

        currentSortieId = sortie.id;

        // Charger le résumé financier
        await loadSortieSummary();
        
        // Charger les colis
        await loadColis();

        loader.classList.add('hidden');
        activeTourneeState.classList.remove('hidden');

        setupRealtime();

    } catch (err) {
        console.error(err);
        loader.innerHTML = `<p class="text-danger" style="text-align:center;">Erreur réseau ou base de données.</p>`;
    }
}

async function loadSortieSummary() {
    try {
        const { data, error } = await supabase
            .from('v_sorties_resume')
            .select('net_a_encaisser, nb_colis_total, nb_livres, nb_retour_signale')
            .eq('id', currentSortieId)
            .maybeSingle();
            
        if (error || !data) return;

        totalVerser.textContent = data.net_a_encaisser.toLocaleString('fr-FR') + ' F';
        
        const traites = data.nb_livres + data.nb_retour_signale;
        progressText.textContent = `${traites} / ${data.nb_colis_total} traités`;

    } catch (err) {
        console.error('Summary error:', err);
    }
}

async function loadColis() {
    try {
        const { data: colis, error } = await supabase
            .from('colis')
            .select('id, valeur, commentaire, photo_path, statut_livreur, created_at')
            .eq('sortie_id', currentSortieId)
            .order('created_at', { ascending: true });

        if (error) throw error;

        colisList.innerHTML = '';
        if (colis && colis.length > 0) {
            for (const c of colis) {
                await renderColisCard(c);
            }
        }
    } catch (err) {
        console.error('Colis error:', err);
    }
}

async function getSignedUrl(photoPath) {
    const now = Date.now();
    // Cache valid 24h, we regenerate 5 minutes before expiration
    const margin = 5 * 60 * 1000; 

    if (signedUrlCache.has(photoPath)) {
        const cached = signedUrlCache.get(photoPath);
        if (now < (cached.expiresAt - margin)) {
            return cached.url;
        }
    }

    // Régénérer
    const expiresInSeconds = 24 * 60 * 60; // 24 heures
    const { data, error } = await supabase.storage
        .from('colis-photos')
        .createSignedUrl(photoPath, expiresInSeconds);

    if (error || !data) {
        console.error('Erreur signed URL:', error);
        return null;
    }

    const expiresAt = now + (expiresInSeconds * 1000);
    signedUrlCache.set(photoPath, { url: data.signedUrl, expiresAt });
    return data.signedUrl;
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

async function renderColisCard(colis, animate = false) {
    let existingCard = document.getElementById(`card-${colis.id}`);
    const isNew = !existingCard;

    if (!existingCard) {
        existingCard = document.createElement('div');
        existingCard.id = `card-${colis.id}`;
        existingCard.className = 'card colis-card';
        if (animate) {
            existingCard.style.opacity = '0';
            existingCard.style.transform = 'translateY(8px)';
        }
        colisList.appendChild(existingCard);
    }

    const url = await getSignedUrl(colis.photo_path);
    const imgSrc = url || '';
    const isPaid = Number(colis.valeur) === 0;
    const priceText = isPaid ? 'PAYÉ' : Number(colis.valeur).toLocaleString('fr-FR') + ' F';
    const priceColor = isPaid ? 'var(--success)' : 'var(--text-main)';

    // Construire le DOM
    let cardHtml = `
        <div class="photo-container">
            <img src="${imgSrc}" loading="lazy" alt="Colis" onclick="window.openFullscreen('${imgSrc}')">
        </div>
        <div class="colis-info flex flex-col gap-2">
            <div class="flex justify-between items-center">
                <span class="font-bold" style="font-size: 1.5rem; color: ${priceColor};">${priceText}</span>
                <span class="badge hidden" id="badge-${colis.id}"></span>
            </div>
            ${colis.commentaire ? `<p class="text-muted">${escapeHtml(colis.commentaire)}</p>` : ''}
            
            <div class="flex gap-2 mt-2">
                <button class="btn btn-outline action-btn btn-livre" id="btn-livre-${colis.id}">LIVRÉ</button>
                <button class="btn btn-outline action-btn btn-retour" id="btn-retour-${colis.id}">RETOUR</button>
            </div>
        </div>
    `;

    existingCard.innerHTML = cardHtml;
    updateCardState(colis.id, colis.statut_livreur);

    // Event listeners
    document.getElementById(`btn-livre-${colis.id}`).addEventListener('click', () => handleAction(colis.id, colis.statut_livreur, 'livre'));
    document.getElementById(`btn-retour-${colis.id}`).addEventListener('click', () => handleAction(colis.id, colis.statut_livreur, 'retourne'));

    if (isNew && animate) {
        gsap.to(existingCard, { opacity: 1, y: 0, duration: 0.3 });
    }
}

window.openFullscreen = (src) => {
    if (!src) return;
    fullscreenImg.src = src;
    fullscreenViewer.style.display = 'flex';
    gsap.to(fullscreenViewer, { opacity: 1, duration: 0.2 });
};

function updateCardState(id, statut) {
    const card = document.getElementById(`card-${id}`);
    if (!card) return;

    const btnLivre = document.getElementById(`btn-livre-${id}`);
    const btnRetour = document.getElementById(`btn-retour-${id}`);
    const badge = document.getElementById(`badge-${id}`);

    // Reset styles
    card.classList.remove('statut-livre', 'statut-retourne');
    btnLivre.className = 'btn btn-outline action-btn btn-livre';
    btnRetour.className = 'btn btn-outline action-btn btn-retour';
    badge.className = 'badge hidden';
    btnLivre.disabled = false;
    btnRetour.disabled = false;

    if (statut === 'livre') {
        card.classList.add('statut-livre');
        btnLivre.classList.replace('btn-outline', 'btn-success');
        badge.textContent = 'LIVRÉ';
        badge.className = 'badge badge-success';
    } else if (statut === 'retourne') {
        card.classList.add('statut-retourne');
        btnRetour.classList.replace('btn-outline', 'btn-danger');
        badge.textContent = 'RETOURNÉ';
        badge.className = 'badge badge-danger';
    }
}

async function handleAction(colisId, currentStatut, requestedAction) {
    if (isOffline) {
        alert("Connexion réseau nécessaire pour mettre à jour ce colis.");
        return;
    }

    const btnLivre = document.getElementById(`btn-livre-${colisId}`);
    const btnRetour = document.getElementById(`btn-retour-${colisId}`);
    
    // Disable temporarily
    btnLivre.disabled = true;
    btnRetour.disabled = true;

    // Undo logic: if clicking the active state, we revert to 'en_attente'
    let newStatut = requestedAction;
    if (currentStatut === requestedAction) {
        newStatut = 'en_attente';
    }

    try {
        const { error } = await supabase.rpc('update_livreur_colis_status', {
            p_colis_id: colisId,
            p_statut: newStatut
        });

        if (error) throw error;

        // Local UI update is handled safely
        // Realtime will also fire, but we can do it immediately for snappiness, or just let realtime do it.
        // Let's do it immediately for better UX.
        updateCardState(colisId, newStatut);
        
        // Update click handlers state. Since we completely replace HTML in renderColisCard we must bind properly,
        // but here we just mutate state safely. To be perfectly sync, we re-bind or just refresh the single card.
        // The easiest robust way is to re-fetch the specific colis or just mutate the event listener logic.
        // Actually, Realtime will push the UPDATE and re-render the card, which is the absolute source of truth.
        // Let's re-fetch v_sorties_resume.
        await loadSortieSummary();

    } catch (err) {
        console.error(err);
        alert("Impossible de mettre à jour le colis.");
        btnLivre.disabled = false;
        btnRetour.disabled = false;
    }
}

function setupRealtime() {
    cleanupRealtime();

    colisSubscription = supabase.channel(`colis-livreur-${currentSortieId}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'colis', filter: `sortie_id=eq.${currentSortieId}` }, async (payload) => {
            showToast("Nouveau colis ajouté");
            await renderColisCard(payload.new, true);
            await loadSortieSummary();
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'colis', filter: `sortie_id=eq.${currentSortieId}` }, async (payload) => {
            await renderColisCard(payload.new, false);
            await loadSortieSummary();
        })
        .subscribe();

    sortieSubscription = supabase.channel(`sortie-livreur-${currentSortieId}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sorties', filter: `id=eq.${currentSortieId}` }, (payload) => {
            if (payload.new.statut === 'cloturee') {
                handleCloture();
            }
        })
        .subscribe();
}

function handleCloture() {
    cleanupRealtime();
    colisList.innerHTML = '';
    activeTourneeState.classList.add('hidden');
    noTourneeState.classList.remove('hidden');
    noTourneeState.innerHTML = `
        <h2 class="text-lg text-danger">Tournée clôturée</h2>
        <p class="text-muted text-sm mt-2">Votre Gérant a clôturé cette tournée.</p>
    `;
    alert("Votre tournée a été clôturée. Vous ne pouvez plus modifier les colis.");
}

function cleanupRealtime() {
    if (colisSubscription) supabase.removeChannel(colisSubscription);
    if (sortieSubscription) supabase.removeChannel(sortieSubscription);
    colisSubscription = null;
    sortieSubscription = null;
}

document.addEventListener('DOMContentLoaded', init);
