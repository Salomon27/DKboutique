import { auth } from './auth.js';
import { supabase } from './config.js';
import { compressImage } from './colis-utils.js';

auth.requireRole(['gerant']);

// Elements
const livreurSelect = document.getElementById('livreurSelect');
const zoneContainer = document.getElementById('zoneContainer');
const zoneDisplay = document.getElementById('zoneDisplay');
const tourneeStatus = document.getElementById('tourneeStatus');
const colisFormContainer = document.getElementById('colisFormContainer');

const photoInput = document.getElementById('photoInput');
const cameraPreview = document.getElementById('cameraPreview');
const photoPlaceholder = document.getElementById('photoPlaceholder');
const montantInput = document.getElementById('montantInput');
const isPaidCheckbox = document.getElementById('isPaidCheckbox');
const noteInput = document.getElementById('noteInput');
const addColisBtn = document.getElementById('addColisBtn');

const localColisGrid = document.getElementById('localColisGrid');
const localColisCount = document.getElementById('localColisCount');
const localTotal = document.getElementById('localTotal');
const validateAllBtn = document.getElementById('validateAllBtn');
const stickyFooter = document.getElementById('stickyFooter');
const gridTitle = document.getElementById('gridTitle');

const progressStatusContainer = document.getElementById('progressStatusContainer');
const progressText = document.getElementById('progressText');
const progressCount = document.getElementById('progressCount');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');

// State
let livreurs = [];
let selectedLivreur = null;
let pendingColis = [];
let activeTourneeId = null;

async function init() {
    await loadLivreurs();
    livreurSelect.addEventListener('change', handleLivreurChange);
    photoInput.addEventListener('change', handlePhotoChange);
    isPaidCheckbox.addEventListener('change', handlePaidToggle);
    addColisBtn.addEventListener('click', addLocalColis);
    validateAllBtn.addEventListener('click', validateAllColis);
}

async function loadLivreurs() {
    try {
        const { data, error } = await supabase
            .from('livreurs')
            .select(`
                id, nom, zone_id, 
                zones ( nom )
            `)
            .eq('actif', true);

        if (error) throw error;
        livreurs = data;

        data.forEach(l => {
            const opt = document.createElement('option');
            opt.value = l.id;
            opt.textContent = l.nom;
            livreurSelect.appendChild(opt);
        });
    } catch (err) {
        console.error('Erreur chargement livreurs:', err);
    }
}

async function handleLivreurChange(e) {
    const lId = e.target.value;
    if (!lId) {
        selectedLivreur = null;
        zoneContainer.classList.add('hidden');
        colisFormContainer.style.opacity = '0.5';
        colisFormContainer.style.pointerEvents = 'none';
        return;
    }

    selectedLivreur = livreurs.find(l => l.id === lId);
    
    zoneDisplay.textContent = selectedLivreur.zones?.nom || 'Sans zone';
    zoneContainer.classList.remove('hidden');

    tourneeStatus.textContent = 'Vérification de la tournée...';
    try {
        const { data, error } = await supabase
            .from('sorties')
            .select('id')
            .eq('livreur_id', selectedLivreur.id)
            .eq('statut', 'en_cours')
            .maybeSingle();
            
        if (error) throw error;

        if (data) {
            activeTourneeId = data.id;
            tourneeStatus.textContent = 'TOURNÉE EN COURS. Vous allez ajouter de nouveaux colis à cette tournée.';
            tourneeStatus.style.color = 'var(--warning)';
        } else {
            activeTourneeId = null;
            tourneeStatus.textContent = 'Aucune tournée active. Une nouvelle sera créée.';
            tourneeStatus.style.color = 'var(--text-muted)';
        }

        colisFormContainer.style.opacity = '1';
        colisFormContainer.style.pointerEvents = 'auto';

    } catch (err) {
        console.error(err);
        tourneeStatus.textContent = 'Erreur lors de la vérification.';
        tourneeStatus.style.color = 'var(--danger)';
    }
}

function handlePaidToggle() {
    if (isPaidCheckbox.checked) {
        montantInput.value = '0';
        montantInput.disabled = true;
    } else {
        montantInput.value = '';
        montantInput.disabled = false;
        montantInput.focus();
    }
}

// Compression d'image côté client (déplacée vers colis-utils.js)

async function handlePhotoChange(e) {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
            cameraPreview.src = ev.target.result;
            cameraPreview.style.display = 'block';
            photoPlaceholder.style.display = 'none';
            // Animation douce
            gsap.fromTo(cameraPreview, { opacity: 0 }, { opacity: 1, duration: 0.3 });
        };
        reader.readAsDataURL(file);
    }
}

async function addLocalColis() {
    const rawFile = photoInput.files[0];
    const montant = montantInput.value.trim();
    const note = noteInput.value.trim();

    if (!rawFile) {
        alert("La photo est obligatoire.");
        return;
    }
    if (montant === '') {
        alert("Veuillez saisir un montant, ou cocher 'Colis déjà payé'.");
        return;
    }

    addColisBtn.disabled = true;
    addColisBtn.textContent = "COMPRESSION...";

    try {
        const compressedFile = await compressImage(rawFile);
        
        const colis = {
            id: crypto.randomUUID(), // UUID définitif généré côté client
            file: compressedFile,
            previewUrl: cameraPreview.src,
            valeur: Number(montant),
            commentaire: note
        };

        pendingColis.push(colis);
        renderPendingColis(true); // true = animate last added
        
        // Reset Form
        photoInput.value = '';
        cameraPreview.style.display = 'none';
        photoPlaceholder.style.display = 'block';
        montantInput.value = '';
        noteInput.value = '';
        isPaidCheckbox.checked = false;
        montantInput.disabled = false;
        
    } catch (err) {
        console.error(err);
        alert("Erreur lors du traitement de la photo.");
    } finally {
        addColisBtn.disabled = false;
        addColisBtn.textContent = "+ AJOUTER LE COLIS";
    }
}

function renderPendingColis(animateLast = false) {
    localColisGrid.innerHTML = '';
    let total = 0;

    if (pendingColis.length > 0) {
        gridTitle.style.display = 'flex';
        stickyFooter.style.display = 'flex';
    } else {
        gridTitle.style.display = 'none';
        stickyFooter.style.display = 'none';
    }

    pendingColis.forEach((colis, index) => {
        total += colis.valeur;

        const card = document.createElement('div');
        card.className = 'photo-card';
        card.id = `colisCard-${colis.id}`;
        
        const img = document.createElement('img');
        img.src = colis.previewUrl;
        
        const overlay = document.createElement('div');
        overlay.className = 'photo-overlay flex justify-between items-center';
        
        const price = document.createElement('span');
        price.textContent = colis.valeur === 0 ? 'PAYÉ' : colis.valeur.toLocaleString('fr-FR') + ' F';
        if (colis.valeur === 0) price.style.color = 'var(--success)';

        const delBtn = document.createElement('button');
        delBtn.textContent = 'Supprimer';
        delBtn.style.background = 'var(--danger)';
        delBtn.style.border = 'none';
        delBtn.style.color = 'white';
        delBtn.style.padding = '4px 8px';
        delBtn.style.borderRadius = '4px';
        delBtn.style.fontSize = '0.8rem';
        
        delBtn.onclick = () => {
            // Animation de suppression
            gsap.to(card, { 
                scale: 0.8, opacity: 0, duration: 0.3, 
                onComplete: () => {
                    pendingColis.splice(index, 1);
                    renderPendingColis();
                }
            });
        };

        overlay.appendChild(price);
        overlay.appendChild(delBtn);
        card.appendChild(img);
        card.appendChild(overlay);

        localColisGrid.appendChild(card);
        
        // Animation du nouvel élément
        if (animateLast && index === pendingColis.length - 1) {
            gsap.to(card, { scale: 1, opacity: 1, duration: 0.4, ease: "back.out(1.5)" });
        } else {
            gsap.set(card, { scale: 1, opacity: 1 });
        }
    });

    localColisCount.textContent = pendingColis.length;
    localTotal.textContent = total.toLocaleString('fr-FR') + ' F';
    validateAllBtn.disabled = pendingColis.length === 0;
}

async function validateAllColis() {
    if (!selectedLivreur || pendingColis.length === 0) return;
    
    validateAllBtn.disabled = true;
    validateAllBtn.textContent = "VALIDATION EN COURS...";
    
    progressStatusContainer.classList.remove('hidden');
    progressContainer.style.display = 'block';
    let successCount = 0;
    const totalCount = pendingColis.length;
    progressCount.textContent = `0 / ${totalCount}`;
    progressBar.style.width = '0%';

    try {
        const user = await auth.requireRole(['gerant']);
        let gerantProfile = await supabase.from('profiles').select('id').eq('auth_user_id', user.id).maybeSingle();
        let gerantId = gerantProfile.data?.id || null;

        let currentSortieId = activeTourneeId;
        let createdNewSortie = false;

        // Etape 1: Gérer la création de la sortie avec gestion de concurrence
        if (!currentSortieId) {
            const { data: newSortie, error: sortieError } = await supabase
                .from('sorties')
                .insert([{
                    livreur_id: selectedLivreur.id,
                    gerant_id: gerantId,
                    zone_id: selectedLivreur.zone_id,
                    statut: 'en_cours'
                }])
                .select()
                .maybeSingle();
            
            if (sortieError) {
                // Possible conflit d'unicité. On essaie de récupérer celle qui vient d'être créée.
                const { data: existingSortie, error: fetchErr } = await supabase
                    .from('sorties')
                    .select('id')
                    .eq('livreur_id', selectedLivreur.id)
                    .eq('statut', 'en_cours')
                    .maybeSingle();
                
                if (existingSortie) {
                    currentSortieId = existingSortie.id;
                    createdNewSortie = false;
                } else {
                    throw sortieError; // Vraie erreur
                }
            } else {
                currentSortieId = newSortie.id;
                createdNewSortie = true;
            }
        }

        const sourceTag = createdNewSortie ? 'initial' : 'ajout';

        // Etape 2: Stratégie de compensation pour chaque colis
        for (const colis of pendingColis) {
            const photoPath = `sorties/${currentSortieId}/${colis.id}.jpg`;
            
            // A. Upload Storage
            const { error: uploadError } = await supabase.storage
                .from('colis-photos')
                .upload(photoPath, colis.file);
                
            if (uploadError) throw uploadError;

            // B. Insertion BDD
            const { error: insertError } = await supabase
                .from('colis')
                .insert([{
                    id: colis.id,
                    sortie_id: currentSortieId,
                    photo_path: photoPath,
                    valeur: colis.valeur,
                    commentaire: colis.commentaire,
                    statut_livreur: 'en_attente',
                    source: sourceTag
                }]);
                
            if (insertError) {
                // COMPENSATION : Suppression de la photo orpheline
                await supabase.storage.from('colis-photos').remove([photoPath]);
                throw insertError;
            }

            // Mise à jour de la progression
            successCount++;
            progressCount.textContent = `${successCount} / ${totalCount}`;
            progressBar.style.width = `${(successCount / totalCount) * 100}%`;
        }

        // Succès complet
        progressText.textContent = "Terminé !";
        progressText.style.color = "var(--success)";
        
        setTimeout(() => {
            alert(createdNewSortie ? "Nouvelle tournée créée avec succès !" : "Colis ajoutés à la tournée avec succès !");
            
            // Reset UX (garder le même livreur pour une saisie en chaîne)
            pendingColis = [];
            renderPendingColis();
            progressStatusContainer.classList.add('hidden');
            progressContainer.style.display = 'none';
            validateAllBtn.disabled = false;
            validateAllBtn.textContent = "VALIDER TOUT";
            
            // Mettre à jour l'état de la tournée affichée
            handleLivreurChange({ target: { value: selectedLivreur.id } });
            
        }, 500);

    } catch (err) {
        console.error("Erreur lors de la validation:", err);
        alert("Une erreur est survenue lors de l'enregistrement. Les colis non confirmés sont restés dans votre panier.");
        
        // Reset bouton mais garde le panier intact
        validateAllBtn.disabled = false;
        validateAllBtn.textContent = "RÉESSAYER";
        progressText.textContent = "Erreur...";
        progressText.style.color = "var(--danger)";
    }
}

document.addEventListener('DOMContentLoaded', init);
