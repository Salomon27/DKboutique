import { supabase } from './config.js';

const signedUrlCache = new Map();

export function formatFcfa(value) {
  return `${Number(value || 0).toLocaleString('fr-FR')} F`;
}

export function formatDate(value, withTime = false) {
  if (!value) return '--';
  const d = new Date(value);
  return d.toLocaleString('fr-FR', withTime
    ? { dateStyle: 'short', timeStyle: 'short' }
    : { dateStyle: 'short' });
}

export function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

export function setText(el, value) {
  if (el) el.textContent = value ?? '';
}

export async function signedPhotoUrl(path, expiresInSeconds = 86400) {
  if (!path) return '';
  if (/^https?:|^blob:/.test(path)) return path;

  const now = Date.now();
  const cached = signedUrlCache.get(path);
  if (cached && now < cached.expiresAt - 300000) return cached.url;

  const { data, error } = await supabase.storage
    .from('colis-photos')
    .createSignedUrl(path, expiresInSeconds);

  if (error || !data?.signedUrl) return '';

  const item = {
    url: data.signedUrl,
    expiresAt: now + expiresInSeconds * 1000
  };
  signedUrlCache.set(path, item);
  return item.url;
}

export function createEmptyState(message) {
  const p = document.createElement('div');
  p.className = 'empty-state';
  p.textContent = message;
  return p;
}

export function createBadge(text, kind = 'primary') {
  const span = document.createElement('span');
  span.className = `badge badge-${kind}`;
  span.textContent = text;
  return span;
}
