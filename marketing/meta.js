// Veroeffentlichen auf Instagram und Facebook ueber die Graph-API von Meta.
// Benoetigt: META_PAGE_ID (Facebook-Seite), META_PAGE_TOKEN (dauerhafter Seiten-Token mit
// pages_manage_posts, instagram_basic, instagram_content_publish) und META_IG_USER_ID
// (Instagram-Business-Konto, das mit der Seite verknuepft ist). Instagram holt Bilder/Videos
// selbst ueber eine oeffentliche URL ab - deshalb liefert das Office-Tool freigegebene Medien
// unter /m/<zufaelliger Schluessel>/... ohne Login aus.

const VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const BASE = `https://graph.facebook.com/${VERSION}`;

function status() {
  return {
    facebook: !!(process.env.META_PAGE_ID && process.env.META_PAGE_TOKEN),
    instagram: !!(process.env.META_IG_USER_ID && process.env.META_PAGE_TOKEN),
  };
}

async function graph(method, pathPart, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: process.env.META_PAGE_TOKEN });
  const url = method === 'GET' ? `${BASE}/${pathPart}?${body}` : `${BASE}/${pathPart}`;
  const res = await fetch(url, method === 'GET' ? {} : { method, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new Error(`Meta: ${e.error_user_msg || e.message || `Fehler ${res.status}`}`);
  }
  return data;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Instagram: erst Container anlegen, bei Videos warten bis verarbeitet, dann veroeffentlichen
async function publishInstagram({ kind, mediaType, url, caption }) {
  const igId = process.env.META_IG_USER_ID;
  const params = {};
  if (mediaType === 'video') {
    params.media_type = kind === 'story' ? 'STORIES' : 'REELS';
    params.video_url = url;
  } else {
    params.image_url = url;
    if (kind === 'story') params.media_type = 'STORIES';
  }
  if (kind !== 'story' && caption) params.caption = caption;
  const container = await graph('POST', `${igId}/media`, params);
  for (let i = 0; i < 60; i++) {
    const st = await graph('GET', container.id, { fields: 'status_code,status' });
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram konnte das Medium nicht verarbeiten (${st.status || st.status_code})`);
    await sleep(mediaType === 'video' ? 10000 : 3000);
  }
  const published = await graph('POST', `${igId}/media_publish`, { creation_id: container.id });
  return published.id;
}

// Facebook-Seite: Beitrag (Foto/Video) oder Foto-Story
async function publishFacebook({ kind, mediaType, url, caption }) {
  const pageId = process.env.META_PAGE_ID;
  if (mediaType === 'video') {
    if (kind === 'story') return null; // Video-Storys auf Seiten brauchen einen Upload-Ablauf - hier nicht unterstuetzt
    const r = await graph('POST', `${pageId}/videos`, { file_url: url, description: caption || '' });
    return r.id;
  }
  if (kind === 'story') {
    const photo = await graph('POST', `${pageId}/photos`, { url, published: 'false' });
    const r = await graph('POST', `${pageId}/photo_stories`, { photo_id: photo.id });
    return r.post_id || r.id || photo.id;
  }
  const r = await graph('POST', `${pageId}/photos`, { url, caption: caption || '' });
  return r.post_id || r.id;
}

async function checkConnection() {
  const out = {};
  if (process.env.META_PAGE_ID && process.env.META_PAGE_TOKEN) {
    try { out.facebook = (await graph('GET', process.env.META_PAGE_ID, { fields: 'name' })).name; } catch (e) { out.facebookError = e.message; }
  }
  if (process.env.META_IG_USER_ID && process.env.META_PAGE_TOKEN) {
    try { out.instagram = '@' + (await graph('GET', process.env.META_IG_USER_ID, { fields: 'username' })).username; } catch (e) { out.instagramError = e.message; }
  }
  return out;
}

module.exports = { status, publishInstagram, publishFacebook, checkConnection };
