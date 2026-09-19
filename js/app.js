import { auth } from './auth.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW échec:', err));
  });
}

import { playIntro, playFocus, playDigitProgress, playVerifying, playSuccess, playError } from './auth-motion.js';

document.addEventListener('DOMContentLoaded', async () => {
    const pinForm = document.getElementById('pinForm');
    const pinInput = document.getElementById('pinInput');
    const statusText = document.getElementById('statusText');

    let isSubmitting = false;

    // Lancement de l'animation d'entrée
    playIntro();

    function setStatus(html, isError = false) {
        statusText.innerHTML = html;
        if (isError) statusText.classList.add('error');
        else statusText.classList.remove('error');
    }

    if (pinForm && pinInput) {
        try {
            await auth.ensureAnonymousSession();
            
            const hasSession = await auth.checkActiveSession();
            if (hasSession) {
                const state = auth.getUIState();
                if (state && state.role) {
                    auth.redirectByRole(state.role);
                } else {
                    await auth.logout();
                }
            }
        } catch (e) {
            console.error(e);
            setStatus('Problème de serveur', true);
            playError();
        }

        // Focus event
        pinInput.addEventListener('focus', () => {
            if (!isSubmitting) playFocus();
        });

        // Typing event
        pinInput.addEventListener('input', () => {
            const val = pinInput.value.trim();
            
            // Limit to numeric only if typing weird characters
            pinInput.value = val.replace(/\D/g, '').substring(0, 4);
            const count = pinInput.value.length;
            
            if (!isSubmitting) {
                playDigitProgress(count);
                
                if (count === 4) {
                    pinInput.blur();
                    submitPinAutomatically(pinInput.value);
                }
            }
        });

        async function submitPinAutomatically(currentPin) {
            if (isSubmitting) return;
            isSubmitting = true;
            pinInput.disabled = true;
            
            playVerifying();
            setStatus('<div class="mini-loader"></div> Vérification...');
            pinInput.classList.remove('input-error');

            try {
                const role = await auth.loginWithPin(currentPin);
                
                setStatus('Connexion réussie');
                playSuccess();
                // Attendre la fin de l'animation avant de rediriger
                setTimeout(() => {
                    auth.redirectByRole(role);
                }, 600);
                
            } catch (error) {
                setStatus(error.message || 'Code PIN incorrect', true);
                pinInput.classList.add('input-error');
                playError();
                pinInput.value = '';
                
                setTimeout(() => {
                    isSubmitting = false;
                    pinInput.disabled = false;
                    pinInput.classList.remove('input-error');
                    setStatus('');
                    pinInput.focus();
                }, 1200); // Wait for error animation before reset
            }
        }

        pinForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const val = pinInput.value.trim();
            if (val.length === 4 && !isSubmitting) {
                pinInput.blur();
                submitPinAutomatically(val);
            }
        });
    }
});
