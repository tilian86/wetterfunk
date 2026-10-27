/* Web Push nach RFC 8291 (Verschlüsselung) und RFC 8292 (VAPID),
   dazu Apple-Push (APNs) für die eigene iPhone-App.
   Ohne fremde Pakete — Cloudflare Workers bringen die nötige Krypto mit.
   Der Ablauf ist starr vorgegeben, deshalb sind die Schritte nummeriert. */

const b64uDecode = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};

const b64uEncode = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const verketten = (...teile) => {
  const gesamt = teile.reduce((n, t) => n + t.length, 0);
  const out = new Uint8Array(gesamt);
  let o = 0;
  for (const t of teile) { out.set(t, o); o += t.length; }
  return out;
};

const text = (s) => new TextEncoder().encode(s);

/** HKDF wie im Standard: erst extrahieren, dann auf Länge bringen. */
async function hkdf(salt, ikm, info, laenge) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, laenge * 8));
}

/** ── 1. VAPID: signiertes Token, das den Absender ausweist ── */
async function vapidHeader(endpoint, privateKeyB64, publicKeyB64, subject) {
  const aud = new URL(endpoint).origin;
  const kopf = b64uEncode(text(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const nutz = b64uEncode(text(JSON.stringify({
    aud, sub: subject,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600
  })));

  const roh = b64uDecode(publicKeyB64);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', ext: true,
    x: b64uEncode(roh.slice(1, 33)),
    y: b64uEncode(roh.slice(33, 65)),
    d: privateKeyB64
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
    key, text(`${kopf}.${nutz}`));

  return `vapid t=${kopf}.${nutz}.${b64uEncode(sig)}, k=${publicKeyB64}`;
}

/** ── 2. Nutzlast für genau diesen Empfänger verschlüsseln ── */
async function verschluesseln(nutzlast, p256dhB64, authB64) {
  const empfaenger = b64uDecode(p256dhB64);
  const auth = b64uDecode(authB64);

  // Einmalschlüsselpaar nur für diese Nachricht
  const paar = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const eigenerPub = new Uint8Array(await crypto.subtle.exportKey('raw', paar.publicKey));

  const fremd = await crypto.subtle.importKey('raw', empfaenger,
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const geheim = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: fremd }, paar.privateKey, 256));

  // Gemeinsames Geheimnis mit beiden öffentlichen Schlüsseln verweben
  const prk = await hkdf(auth, geheim,
    verketten(text('WebPush: info\0'), empfaenger, eigenerPub), 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, text('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, text('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // Das 0x02 markiert das Ende der Nutzlast (Padding-Trenner)
  const klartext = verketten(text(nutzlast), new Uint8Array([2]));
  const chiffre = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, klartext));

  // Kopf: Salz (16) + Satzlänge (4) + Länge des Schlüssels (1) + Schlüssel (65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return verketten(salt, rs, new Uint8Array([eigenerPub.length]), eigenerPub, chiffre);
}

/** ── 3. Apple-Push (APNs) für die eigene iPhone-App ──
   Die App meldet sich mit ihrem Gerätetoken statt mit einem Web-Push-Abo an.
   Absender ist ein Schlüssel aus dem Apple-Entwicklerkonto (.p8). Er liegt
   als Geheimnis APNS_KEY im Worker, nie im Code. Er gilt für das ganze Team,
   also für jede eigene App: Welche gemeint ist, sagt das Thema (Bundle-ID). */
const APNS_HOST = { development: 'api.sandbox.push.apple.com', production: 'api.push.apple.com' };

export const apnsBereit = (env) => !!(env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID);

let apnsToken = null;

/* Apple nimmt ein Token bis zu einer Stunde, verbietet aber, es öfter als
   alle 20 Minuten zu erneuern. Jede Worker-Instanz baute sonst ihr eigenes —
   deshalb liegt es zusätzlich in KV, geschrieben nur, wenn wirklich eine
   Meldung hinausgeht. */
async function apnsJwt(env) {
  const jetzt = Math.floor(Date.now() / 1000);
  const frisch = (t) => t?.jwt && jetzt - t.seit < 45 * 60;
  if (frisch(apnsToken)) return apnsToken.jwt;
  const gemerkt = await env.WF_PUSH.get('apns:jwt', 'json');
  if (frisch(gemerkt)) { apnsToken = gemerkt; return gemerkt.jwt; }

  const pem = env.APNS_KEY.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const kopf = b64uEncode(text(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })));
  const nutz = b64uEncode(text(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: jetzt })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, text(`${kopf}.${nutz}`));
  apnsToken = { jwt: `${kopf}.${nutz}.${b64uEncode(sig)}`, seit: jetzt };
  await env.WF_PUSH.put('apns:jwt', JSON.stringify(apnsToken), { expirationTtl: 50 * 60 });
  return apnsToken.jwt;
}

async function sendApns(abo, nutzlast, env) {
  // Ohne Schlüssel kein Versand — die Wache in der App meldet dann selbst.
  if (!apnsBereit(env)) return 503;
  const d = JSON.parse(nutzlast);
  const art = d.art || 'regen';
  const koerper = JSON.stringify({
    aps: {
      alert: { title: d.titel || 'Wetterfunk', body: d.text || '' },
      sound: 'default',
      // Gruppiert die Meldungen in der Mitteilungszentrale wie die App selbst
      'thread-id': art === 'warnung' ? 'warnung' : ['himmel', 'abend'].includes(art) ? 'himmel' : 'regen'
    },
    art
  });
  const schicken = async (umgebung) => fetch(`https://${APNS_HOST[umgebung]}/3/device/${abo.apns}`, {
    method: 'POST',
    headers: {
      'authorization': `bearer ${await apnsJwt(env)}`,
      'apns-topic': abo.thema,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      // Nach einer halben Stunde ist eine Regenmeldung wertlos — wie beim Web-Push
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 1800),
      // Gleiche Kennung ersetzt die vorige Meldung, wie „tag" im Browser
      ...(d.tag ? { 'apns-collapse-id': String(d.tag).slice(0, 64) } : {})
    },
    body: koerper
  });

  const umgebung = abo.umgebung === 'production' ? 'production' : 'development';
  let res = await schicken(umgebung);
  if (res.status === 400 && (await res.json().catch(() => ({}))).reason === 'BadDeviceToken') {
    /* Token aus der anderen Umgebung: Entwickler- und App-Store-Signatur
       haben getrennte Push-Server. Einmal drüben versuchen; klappt es, merkt
       sich das Abo die Umgebung (wird mit dem Eintrag gespeichert). */
    const andere = umgebung === 'production' ? 'development' : 'production';
    res = await schicken(andere);
    if (res.status < 300) abo.umgebung = andere;
    else if (res.status === 400) return 410;
  }
  // Abgelehntes Token (abgelaufen, falscher Schlüssel): beim nächsten Mal neu bauen
  if (res.status === 403) { apnsToken = null; await env.WF_PUSH.delete('apns:jwt'); }
  return res.status;
}

/** Eine Nachricht zustellen. Gibt den HTTP-Status des Push-Dienstes zurück. */
export async function sendPush(abo, nutzlast, env) {
  if (abo.apns) return sendApns(abo, nutzlast, env);
  const koerper = await verschluesseln(nutzlast, abo.keys.p256dh, abo.keys.auth);
  const auth = await vapidHeader(abo.endpoint, env.VAPID_PRIVATE, env.VAPID_PUBLIC, env.VAPID_SUBJECT);

  const res = await fetch(abo.endpoint, {
    method: 'POST',
    headers: {
      'authorization': auth,
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      'ttl': '1800',
      'urgency': 'normal'
    },
    body: koerper
  });
  return res.status;
}
