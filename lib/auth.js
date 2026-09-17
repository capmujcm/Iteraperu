'use strict';
// -----------------------------------------------------------------------------
// Autenticación de asistentes: DNI + contraseña propia
// -----------------------------------------------------------------------------
// Se usa scrypt del módulo `crypto` nativo de Node en lugar de bcrypt/argon2
// para no añadir dependencias (checklist del proyecto, punto 7). scrypt es
// resistente a GPU y forma parte de la librería estándar desde Node 10.
const crypto = require('crypto');
const { promisify } = require('util');

// Version asincrona de scrypt. La sincrona bloquea el hilo de Node entero
// mientras calcula: durante esos ~100 ms el servidor no atiende NADA, ni un
// escaneo de puesto ni un check-in. En la hora punta de la puerta, con varias
// personas registrandose o ingresando por segundo, el proceso se pasaba el dia
// bloqueado. La asincrona hace el mismo calculo en el threadpool y el servidor
// sigue respondiendo.
const scrypt = promisify(crypto.scrypt);

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
const TEMP_PASSWORD_TTL_MS = 30 * 60 * 1000; // 30 minutos (restablecimiento)

// Registro rapido en puerta: la persona entra al recinto y se acuerda de su
// cuenta horas despues, cuando quiere escanear un puesto. Con 30 minutos la
// clave ya habia caducado y tenia que volver al Punto de Ayuda.
//
// Cubre las DOS jornadas a proposito: el evento es sabado y domingo, y con 14
// horas quien fue registrado el sabado por la tarde se encontraba el domingo
// con la clave vencida y una cola en el Punto de Ayuda por delante. Sigue
// siendo de un solo uso, porque obliga a cambiarla al entrar.
const TEMP_PASSWORD_PUERTA_TTL_MS = 40 * 60 * 60 * 1000; // 40 horas

// Clave temporal de un puesto participante. Se reparten en la semana previa
// -impresas o por WhatsApp- y el responsable puede no abrir el panel hasta el
// dia del evento. Con 7 dias, repartirlas el lunes significaba que el sabado
// ya no servian. Vivia copiada en tres archivos; aqui hay una sola.
const TEMP_EMPRESA_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 dias

// Duración de la sesión en el dispositivo. El evento dura días, no meses.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

// Bloqueo por intentos fallidos sobre un mismo DNI.
const MAX_FAILED_LOGINS = 8;
const LOCK_MS = 15 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// AMBAS SON ASINCRONAS. Devuelven una promesa, asi que toda llamada lleva
// `await`. Sin el, `verifyPassword(...)` devuelve el objeto Promise, que es
// truthy, y un `if (!verifyPassword(...))` dejaria pasar CUALQUIER contrasena.
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(String(plain), salt, KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p
  });
  return { hash: derived.toString('hex'), salt, algo: 'scrypt' };
}

// Comparación en tiempo constante: no revela cuántos bytes coincidían.
async function verifyPassword(plain, hash, salt) {
  if (!hash || !salt) return false;
  if (typeof plain !== 'string' || plain.length > MAX_PASSWORD_LEN) return false;
  let derived;
  try {
    derived = await scrypt(plain, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
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

// Clave temporal legible, para entregar a un puesto participante. Se dicta por
// teléfono y se copia a mano, así que el alfabeto excluye 0/O y 1/I. Aleatoria
// por puesto: a diferencia de CF2026, que se grita en la cola del Punto de
// Ayuda, esta no es un valor público y no tiene por qué serlo.
const ALFABETO_LEGIBLE = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function claveLegible(largo = 8) {
  const bytes = crypto.randomBytes(largo);
  let s = '';
  for (let i = 0; i < largo; i++) s += ALFABETO_LEGIBLE[bytes[i] % ALFABETO_LEGIBLE.length];
  return s;
}

module.exports = {
  TEMP_PASSWORD,
  TEMP_PASSWORD_TTL_MS,
  TEMP_PASSWORD_PUERTA_TTL_MS,
  TEMP_EMPRESA_TTL_MS,
  SESSION_TTL_MS,
  MAX_FAILED_LOGINS,
  LOCK_MS,
  sha256,
  hashPassword,
  verifyPassword,
  validatePassword,
  normalizeDni,
  newSessionToken,
  newQrToken,
  claveLegible
};
