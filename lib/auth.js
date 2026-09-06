'use strict';
// -----------------------------------------------------------------------------
// Autenticación de asistentes: DNI + contraseña propia
// -----------------------------------------------------------------------------
// Se usa scrypt del módulo `crypto` nativo de Node en lugar de bcrypt/argon2
// para no añadir dependencias (checklist del proyecto, punto 7). scrypt es
// resistente a GPU y forma parte de la librería estándar desde Node 10.
const crypto = require('crypto');

// Parámetros de scrypt. N=16384 => ~16 MB de memoria y ~100 ms por hash en el
// hardware de Railway: suficiente para frenar el crackeo masivo sin volver
// lenta la fila de la puerta.
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;
const MAX_PASSWORD_LEN = 200; // corta ataques de DoS por contraseñas enormes

// Contraseña temporal que entrega soporte en el Punto de Ayuda.
// Es un valor conocido y adivinable a propósito (se dicta en voz alta), por eso
// SIEMPRE va acompañada de caducidad + cambio obligatorio en el primer ingreso.
const TEMP_PASSWORD = 'CF2026';
const TEMP_PASSWORD_TTL_MS = 30 * 60 * 1000; // 30 minutos

// Duración de la sesión en el dispositivo. El evento dura días, no meses.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

// Bloqueo por intentos fallidos sobre un mismo DNI.
const MAX_FAILED_LOGINS = 8;
const LOCK_MS = 15 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain), salt, KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p
  });
  return { hash: derived.toString('hex'), salt, algo: 'scrypt' };
}

// Comparación en tiempo constante: no revela cuántos bytes coincidían.
function verifyPassword(plain, hash, salt) {
  if (!hash || !salt) return false;
  if (typeof plain !== 'string' || plain.length > MAX_PASSWORD_LEN) return false;
  let derived;
  try {
    derived = crypto.scryptSync(plain, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  } catch (e) {
    return false;
  }
  const stored = Buffer.from(String(hash), 'hex');
  if (stored.length !== derived.length) return false;
  return crypto.timingSafeEqual(stored, derived);
}

// Política deliberadamente laxa: público general en la cola de un evento.
// Se exige solo una longitud mínima; imponer mayúsculas y símbolos aquí
// produce contraseñas apuntadas en papel, que es peor.
function validatePassword(plain) {
  if (typeof plain !== 'string') return { ok: false, error: 'Contraseña inválida.' };
  const p = plain.trim();
  if (p.length < 6) return { ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' };
  if (p.length > MAX_PASSWORD_LEN) return { ok: false, error: 'La contraseña es demasiado larga.' };
  if (p.toUpperCase() === TEMP_PASSWORD) {
    return { ok: false, error: 'Esa es la contraseña temporal de soporte. Elige una distinta.' };
  }
  return { ok: true, value: p };
}

// DNI peruano: 8 dígitos. Se aceptan hasta 15 caracteres alfanuméricos para
// carné de extranjería y pasaporte, que también asisten al evento.
function normalizeDni(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const d = String(raw).trim().toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[A-Z0-9]{6,15}$/.test(d)) return null;
  return d;
}

// Token de sesión: 32 bytes aleatorios. Se entrega al cliente en claro y se
// guarda solo su SHA-256, para que una fuga de la base no ceda sesiones vivas.
function newSessionToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: sha256(token) };
}

// Token del QR: aleatorio, no derivado del DNI. Antes era `tok-<dni>`, lo que
// permitía fabricar un ticket válido conociendo solo el documento.
function newQrToken() {
  return crypto.randomBytes(24).toString('base64url');
}

module.exports = {
  TEMP_PASSWORD,
  TEMP_PASSWORD_TTL_MS,
  SESSION_TTL_MS,
  MAX_FAILED_LOGINS,
  LOCK_MS,
  sha256,
  hashPassword,
  verifyPassword,
  validatePassword,
  normalizeDni,
  newSessionToken,
  newQrToken
};
