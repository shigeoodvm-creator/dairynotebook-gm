/* license-core.js — DairyNotebook 共通ライセンス検証コア（ブラウザ/Node両対応） */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.DNLicenseCore = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;

  function base64urlToBytes(b64u) {
    var b64 = String(b64u).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = (typeof atob === 'function') ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToUtf8(bytes) {
    if (typeof TextDecoder === 'function') return new TextDecoder().decode(bytes);
    return Buffer.from(bytes).toString('utf8');
  }

  function normalizeCode(codeString) {
    return String(codeString || '').trim().replace(/\s+/g, '');
  }

  async function sha256Hex(text) {
    if (!subtle) throw new Error('crypto.subtle unavailable');
    var data = new TextEncoder().encode(String(text));
    var hash = await subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  async function getDeviceId() {
    var cached = null;
    try { cached = localStorage.getItem('dn_device_v1'); } catch (e) {}
    if (cached) return cached;

    var parts = [
      navigator.userAgent || '',
      navigator.language || '',
      String(screen.width) + 'x' + String(screen.height),
      String(screen.colorDepth),
      String(new Date().getTimezoneOffset()),
      String(navigator.hardwareConcurrency || 0),
      navigator.platform || ''
    ];
    var id = (await sha256Hex(parts.join('|'))).slice(0, 32);
    try { localStorage.setItem('dn_device_v1', id); } catch (e2) {}
    return id;
  }

  async function verifyLicense(codeString, appId, publicJwk, nowMs) {
    codeString = normalizeCode(codeString);
    if (typeof codeString !== 'string' || !codeString) return { valid: false, reason: 'format' };
    var parts = codeString.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: 'format' };
    var payloadB64 = parts[0], sigB64 = parts[1];

    var key;
    try {
      key = await subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch (e) { return { valid: false, reason: 'key' }; }

    var ok;
    try {
      var data = new TextEncoder().encode(payloadB64);
      var sig = base64urlToBytes(sigB64);
      ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
    } catch (e) { return { valid: false, reason: 'signature' }; }
    if (!ok) return { valid: false, reason: 'signature' };

    var payload;
    try { payload = JSON.parse(bytesToUtf8(base64urlToBytes(payloadB64))); }
    catch (e) { return { valid: false, reason: 'format' }; }

    var apps = Array.isArray(payload.apps) ? payload.apps : [];
    if (apps.indexOf(appId) < 0) return { valid: false, reason: 'app' };

    var expMs = new Date(payload.exp + 'T23:59:59').getTime();
    if (!(nowMs <= expMs)) return { valid: false, reason: 'expired', exp: payload.exp };

    var features = Array.isArray(payload.features) ? payload.features : [];
    return { valid: true, exp: payload.exp, apps: apps, features: features, note: payload.note };
  }

  async function checkActivation(apiUrl, token, deviceId) {
    var qs = new URLSearchParams({ token: token, action: 'activation_check', deviceId: deviceId });
    var res = await fetch(apiUrl + '?' + qs.toString(), { method: 'GET' });
    return res.json();
  }

  async function registerActivation(apiUrl, token, code, deviceId, appId) {
    var res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        token: token,
        action: 'activate',
        code: normalizeCode(code),
        deviceId: deviceId,
        app: appId
      })
    });
    return res.json();
  }

  return {
    verifyLicense: verifyLicense,
    base64urlToBytes: base64urlToBytes,
    normalizeCode: normalizeCode,
    getDeviceId: getDeviceId,
    checkActivation: checkActivation,
    registerActivation: registerActivation
  };
});
