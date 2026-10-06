// Veroeffentlichen auf Instagram und Facebook ueber die Graph-API von Meta - fuer mehrere Konten.
// Jedes Konto (mk_accounts) hat eine eigene Verbindung:
//  - kind 'facebook': Seiten-Token (dauerhaft) einer Facebook-Seite, optional mit verknuepftem
//    Instagram-Business-Konto. Kommt ueber "Mit Facebook verbinden" (OAuth, META_APP_ID/META_APP_SECRET)
//    oder einen eingefuegten Token. Posts gehen an graph.facebook.com.
//  - kind 'instagram': Instagram-Token aus "Instagram API mit Instagram-Login" (ohne Facebook-Seite),
//    gilt 60 Tage und wird automatisch verlaengert. Posts gehen an graph.instagram.com.
// Instagram holt Bilder/Videos selbst ueber eine oeffentliche URL ab - deshalb liefert das Office-Tool
// freigegebene Medien unter /m/<zufaelliger Schluessel>.jpg ohne Login aus.

const VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const FB = `https://graph.facebook.com/${VERSION}`;
const IG = `https://graph.instagram.com/${VERSION}`;

const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management', 'instagram_basic', 'instagram_content_publish'];

function oauthConfigured() {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

// Verbindungsdaten eines Kontos -> was davon nutzbar ist
function accountStatus(acc) {
  const has = !!(acc && acc.token);
  return {
    facebook: has && acc.token_kind === 'facebook' && !!acc.fb_page_id,
    instagram: has && !!acc.ig_user_id,
  };
}

async function request(base, method, pathPart, params, token) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const url = method === 'GET' ? `${base}/${pathPart}?${body}` : `${base}/${pathPart}`;
  const res = await fetch(url, method === 'GET' ? {} : { method, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    const err = new Error(`Meta: ${e.error_user_msg || e.message || `Fehler ${res.status}`}`);
    err.code = e.code;
    throw err;
  }
  return data;
}

const igBase = (acc) => (acc.token_kind === 'instagram' ? IG : FB);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Instagram: erst Container anlegen, bei Videos warten bis verarbeitet, dann veroeffentlichen
async function publishInstagram(acc, { kind, mediaType, url, caption }) {
  const call = (method, p, params) => request(igBase(acc), method, p, params, acc.token);
  const params = {};
  if (mediaType === 'video') {
    params.media_type = kind === 'story' ? 'STORIES' : 'REELS';
    params.video_url = url;
  } else {
    params.image_url = url;
    if (kind === 'story') params.media_type = 'STORIES';
  }
  if (kind !== 'story' && caption) params.caption = caption;
  const container = await call('POST', `${acc.ig_user_id}/media`, params);
  for (let i = 0; i < 60; i++) {
    const st = await call('GET', container.id, { fields: 'status_code,status' });
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram konnte das Medium nicht verarbeiten (${st.status || st.status_code})`);
    await sleep(mediaType === 'video' ? 10000 : 3000);
  }
  const published = await call('POST', `${acc.ig_user_id}/media_publish`, { creation_id: container.id });
  return published.id;
}

// Facebook-Seite: Beitrag (Foto/Video) oder Foto-Story
async function publishFacebook(acc, { kind, mediaType, url, caption }) {
  const call = (method, p, params) => request(FB, method, p, params, acc.token);
  const pageId = acc.fb_page_id;
  if (mediaType === 'video') {
    if (kind === 'story') return null; // Video-Storys auf Seiten brauchen einen Upload-Ablauf - hier nicht unterstuetzt
    const r = await call('POST', `${pageId}/videos`, { file_url: url, description: caption || '' });
    return r.id;
  }
  if (kind === 'story') {
    const photo = await call('POST', `${pageId}/photos`, { url, published: 'false' });
    const r = await call('POST', `${pageId}/photo_stories`, { photo_id: photo.id });
    return r.post_id || r.id || photo.id;
  }
  const r = await call('POST', `${pageId}/photos`, { url, caption: caption || '' });
  return r.post_id || r.id;
}

// Verbindung eines Kontos live pruefen (Name der Seite, Instagram-Benutzername)
async function checkAccount(acc) {
  const out = {};
  const st = accountStatus(acc);
  if (st.facebook) {
    try { out.facebook = (await request(FB, 'GET', acc.fb_page_id, { fields: 'name' }, acc.token)).name; } catch (e) { out.facebookError = e.message; }
  }
  if (st.instagram) {
    try { out.instagram = '@' + (await request(igBase(acc), 'GET', acc.ig_user_id, { fields: 'username' }, acc.token)).username; } catch (e) { out.instagramError = e.message; }
  }
  return out;
}

// ---------- Verbinden ----------
function oauthUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: process.env.META_APP_ID, redirect_uri: redirectUri, state, response_type: 'code', scope: SCOPES.join(','),
  });
  return `https://www.facebook.com/${VERSION}/dialog/oauth?${p}`;
}

async function exchangeCode(code, redirectUri) {
  const r = await request(FB, 'GET', 'oauth/access_token', {
    client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, redirect_uri: redirectUri, code,
  }, '');
  return longLivedUserToken(r.access_token);
}

// Kurzlebigen Benutzer-Token (1-2 Std.) in einen 60-Tage-Token tauschen - Seiten-Token daraus laufen dann nicht ab
async function longLivedUserToken(token) {
  if (!oauthConfigured()) return token;
  try {
    const r = await request(FB, 'GET', 'oauth/access_token', {
      grant_type: 'fb_exchange_token', client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, fb_exchange_token: token,
    }, '');
    return r.access_token || token;
  } catch (e) {
    return token;
  }
}

// Alle Facebook-Seiten (mit Seiten-Token und verknuepftem Instagram-Konto), auf die ein Benutzer-Token Zugriff hat
async function pagesForUserToken(userToken) {
  const pages = [];
  let next = `me/accounts`;
  let params = { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100' };
  for (let i = 0; next && i < 10; i++) {
    const r = await request(FB, 'GET', next, params, userToken);
    for (const p of r.data || []) {
      pages.push({
        fb_page_id: p.id, fb_page_name: p.name, token: p.access_token,
        ig_user_id: p.instagram_business_account ? p.instagram_business_account.id : null,
        ig_username: p.instagram_business_account ? p.instagram_business_account.username : null,
      });
    }
    const after = r.paging && r.paging.cursors && r.paging.next ? r.paging.cursors.after : null;
    next = after ? 'me/accounts' : null;
    params = { ...params, after };
  }
  return pages;
}

// Eingefuegten Token einordnen: Instagram-Token, Seiten-Token oder Benutzer-Token.
// Liefert eine Liste moeglicher Verbindungen (wie pagesForUserToken).
async function resolveToken(token) {
  token = String(token || '').trim();
  if (!token) throw new Error('Bitte einen Token einfügen');
  // Instagram-Login-Token (beginnt meist mit "IG")
  if (/^IG/.test(token)) {
    const me = await request(IG, 'GET', 'me', { fields: 'user_id,username' }, token);
    return [{ token_kind: 'instagram', token, ig_user_id: String(me.user_id || me.id), ig_username: me.username, fb_page_id: null, fb_page_name: null, expires_in_days: 60 }];
  }
  // Benutzer-Token? Dann liefert me/accounts die Seiten
  const userToken = await request(FB, 'GET', 'me/accounts', { limit: '1' }, token).then(() => true).catch(() => false);
  if (userToken) {
    const long = await longLivedUserToken(token);
    return (await pagesForUserToken(long)).map(p => ({ ...p, token_kind: 'facebook' }));
  }
  let page;
  try {
    page = await request(FB, 'GET', 'me', { fields: 'id,name,instagram_business_account{id,username}' }, token);
  } catch (e) {
    // Vielleicht doch ein Instagram-Token ohne "IG"-Praefix
    const ig = await request(IG, 'GET', 'me', { fields: 'user_id,username' }, token).catch(() => null);
    if (ig) return [{ token_kind: 'instagram', token, ig_user_id: String(ig.user_id || ig.id), ig_username: ig.username, fb_page_id: null, fb_page_name: null, expires_in_days: 60 }];
    throw e;
  }
  const ig = page.instagram_business_account || null;
  return [{ token_kind: 'facebook', token, fb_page_id: page.id, fb_page_name: page.name, ig_user_id: ig ? ig.id : null, ig_username: ig ? ig.username : null }];
}

// Instagram-Login-Token verlaengern (wieder 60 Tage gueltig; geht ab 24 Std. nach Ausstellung)
async function refreshInstagramToken(token) {
  const r = await request(IG.replace(`/${VERSION}`, ''), 'GET', 'refresh_access_token', { grant_type: 'ig_refresh_token' }, token);
  return { token: r.access_token, expiresIn: r.expires_in };
}

module.exports = {
  oauthConfigured, accountStatus, publishInstagram, publishFacebook, checkAccount,
  oauthUrl, exchangeCode, pagesForUserToken, resolveToken, refreshInstagramToken,
};
