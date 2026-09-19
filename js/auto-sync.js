import { supabase } from './config.js';

// Lecture automatique uniquement : aucun clic ni mutation n'est rejoué.
// Realtime accélère les mises à jour, un contrôle périodique couvre les reconnexions
// et les installations où la publication Realtime n'est pas activée.
export function enableAutoSync(refresh, {
  tables = [],
  intervalMs = 30000,
  shouldRefresh = () => true,
  headerStatus = true
} = {}) {
  let disposed = false;
  let running = false;
  let pending = false;
  let lastSuccess = 0;
  let lastAttempt = 0;
  let retryTimer = null;
  let channel = null;

  const badge = document.createElement('span');
  badge.className = 'dk-sync-state';
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');

  function setState(type, description) {
    if (!headerStatus) return;
    badge.dataset.state = type;
    badge.setAttribute('aria-label', description);
    badge.title = description;
    badge.textContent = type === 'offline' ? 'Hors ligne'
      : type === 'error' ? 'À vérifier'
      : type === 'syncing' ? 'Synchronisation…'
      : type === 'ready' ? 'Auto' : 'À jour';
  }

  if (headerStatus) {
    const header = document.querySelector('.app-header');
    if (header) {
      header.appendChild(badge);
      setState(navigator.onLine ? 'ready' : 'offline', navigator.onLine
        ? 'Synchronisation automatique active · vérification à venir' : 'Hors ligne : connexion nécessaire');
    }
  }

  function canRead() {
    return !disposed && navigator.onLine && !document.hidden && shouldRefresh();
  }

  function schedule(reason = 'change') {
    if (disposed) return;
    pending = true;
    if (!navigator.onLine) {
      setState('offline', 'Hors ligne : la consultation peut être ancienne. Les enregistrements nécessitent Internet.');
      return;
    }
    if (!canRead()) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => run(reason), reason === 'change' ? 500 : 100);
  }

  async function run(reason) {
    retryTimer = null;
    if (!canRead()) return;
    if (running) {
      pending = true;
      return;
    }
    if (reason === 'focus' && lastSuccess && Date.now() - lastSuccess < 7000) {
      pending = false;
      return;
    }
    if (reason === 'interval' && Date.now() - lastAttempt < 12000) return;

    running = true;
    pending = false;
    lastAttempt = Date.now();
    setState('syncing', 'Actualisation automatique en cours');
    try {
      await refresh();
      if (disposed) return;
      lastSuccess = Date.now();
      setState('ok', 'Données actualisées · ' + new Date(lastSuccess).toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit'
      }));
    } catch (error) {
      if (disposed) return;
      console.error('Synchronisation DK Boutique:', error);
      setState('error', 'Actualisation impossible. Nouvelle tentative automatique.');
    } finally {
      running = false;
      // A new change received during a fetch triggers a second read, but not a loop
      // while the user is editing a form.
      if (pending && canRead()) schedule('change');
    }
  }

  const onVisibility = () => { if (!document.hidden) schedule('focus'); };
  const onOnline = () => schedule('online');
  const onOffline = () => setState('offline', 'Hors ligne : reconnexion requise');
  const onFocusOut = () => {
    if (pending && canRead()) schedule('focus');
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('focusout', onFocusOut);

  // Browsers throttle background tabs; the return-to-app listener catches up.
  const interval = setInterval(() => schedule('interval'), Math.max(15000, intervalMs));
  // Initial read also verifies connectivity; it never submits any business operation.
  schedule('initial');

  if (tables.length) {
    channel = supabase.channel('dk-auto-' + Math.random().toString(36).slice(2));
    for (const table of [...new Set(tables)]) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => schedule('change'));
    }
    channel.subscribe(status => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // Polling is still active. No write is attempted by the sync loop.
        if (navigator.onLine) setState('error', 'Temps réel indisponible, vérification périodique active');
      }
    });
  }

  window.addEventListener('pagehide', () => {
    disposed = true;
    clearInterval(interval);
    if (retryTimer) clearTimeout(retryTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('focusout', onFocusOut);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    if (channel) supabase.removeChannel(channel);
  }, { once: true });

  return { refreshNow: () => schedule('manual') };
}
