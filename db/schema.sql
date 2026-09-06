-- =============================================================================
-- ITERAPerú Database Schema (PostgreSQL) — Optimized for Low Footprint
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Leads de la web (Diagnóstico & Calculadora de ROI)
CREATE TABLE IF NOT EXISTS leads_diagnostico (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre VARCHAR(120) NOT NULL,
  empresa VARCHAR(150) NOT NULL,
  cargo VARCHAR(100),
  email VARCHAR(150) NOT NULL,
  telefono VARCHAR(50),
  tamano_empresa VARCHAR(50),
  desafio VARCHAR(100),
  horas_semanales_perdidas INT DEFAULT 0,
  ahorro_estimado_usd NUMERIC(10,2) DEFAULT 0,
  mensaje TEXT,
  origen VARCHAR(50) DEFAULT 'web_itera',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leads_created ON leads_diagnostico (created_at DESC);

-- 2. Eventos de la plataforma
CREATE TABLE IF NOT EXISTS eventos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug VARCHAR(80) UNIQUE NOT NULL,
  nombre VARCHAR(200) NOT NULL,
  descripcion TEXT,
  fecha_inicio TIMESTAMP WITH TIME ZONE,
  fecha_fin TIMESTAMP WITH TIME ZONE,
  lugar VARCHAR(250),
  aforo_max INT DEFAULT 500,
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Asistentes & Tickets QR
CREATE TABLE IF NOT EXISTS asistentes_tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
  codigo_ticket VARCHAR(30) UNIQUE NOT NULL, -- ej. ITR-8821
  qr_token VARCHAR(64) UNIQUE NOT NULL,      -- token para validación rápida
  nombre VARCHAR(120) NOT NULL,
  apellido VARCHAR(120) NOT NULL,
  email VARCHAR(150) NOT NULL,
  empresa VARCHAR(150),
  cargo VARCHAR(100),
  tipo_ticket VARCHAR(50) DEFAULT 'general', -- general, vip, speaker, staff, prensa
  estado VARCHAR(30) DEFAULT 'valido',       -- valido, checkin, cancelado
  checkin_count INT DEFAULT 0,
  ultimo_checkin TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tickets_qr ON asistentes_tickets (qr_token);
CREATE INDEX IF NOT EXISTS idx_tickets_codigo ON asistentes_tickets (codigo_ticket);

-- 4. Log de Check-ins (Accesos en Puerta)
CREATE TABLE IF NOT EXISTS checkins_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id UUID REFERENCES asistentes_tickets(id) ON DELETE CASCADE,
  puerta VARCHAR(80) DEFAULT 'Principal',
  staff_nombre VARCHAR(100),
  tipo_acceso VARCHAR(20) DEFAULT 'entrada', -- entrada, salida
  resultado VARCHAR(30) DEFAULT 'exitoso',    -- exitoso, duplicado, denegado
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Leads de Expositores / Stands (Networking & B2B)
CREATE TABLE IF NOT EXISTS leads_stands (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
  expositor_nombre VARCHAR(120) NOT NULL,
  asistente_ticket_id UUID REFERENCES asistentes_tickets(id) ON DELETE CASCADE,
  interes_nivel VARCHAR(30) DEFAULT 'medio', -- bajo, medio, alto, cierre
  notas TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Preguntas en Vivo (Q&A de Speakers)
CREATE TABLE IF NOT EXISTS preguntas_live (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
  autor_nombre VARCHAR(120) DEFAULT 'Anónimo',
  pregunta TEXT NOT NULL,
  votos INT DEFAULT 0,
  respondida BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- 7. Autenticación de asistentes: DNI + contraseña propia
-- =============================================================================
-- Regla de negocio: la persona entra con su DNI y una contraseña que elige ella
-- misma. Antes el re-ingreso dependía de un enlace al celular/WhatsApp, lo que
-- dejaba fuera a quien registró mal su número. La sesión se mantiene en el
-- mismo dispositivo mediante un token de sesión (tabla `sesiones`).
--
-- NUNCA se guarda la contraseña en claro: solo el hash scrypt y su sal.

-- El DNI y el celular no existían en el esquema original.
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS dni VARCHAR(15);
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS celular VARCHAR(30);

-- Registro rápido en puerta: nunca se bloquea el ingreso por falta de correo.
ALTER TABLE asistentes_tickets ALTER COLUMN email DROP NOT NULL;
ALTER TABLE asistentes_tickets ALTER COLUMN apellido DROP NOT NULL;

ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS password_salt TEXT;
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS password_algo VARCHAR(20) DEFAULT 'scrypt';
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMP WITH TIME ZONE;

-- Restablecimiento por soporte: la contraseña temporal (CF2026) caduca y
-- obliga a definir una nueva en el primer ingreso.
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false;
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS temp_password_expires_at TIMESTAMP WITH TIME ZONE;

-- Freno a la fuerza bruta sobre un DNI concreto.
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS failed_login_count INT DEFAULT 0;
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP WITH TIME ZONE;

-- Un DNI identifica a una sola persona dentro de un mismo evento.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_evento_dni
  ON asistentes_tickets (evento_id, dni) WHERE dni IS NOT NULL;

-- 8. Sesiones activas (una por dispositivo)
-- Se almacena el SHA-256 del token, nunca el token: si la base se filtra, las
-- sesiones vivas no quedan expuestas.
CREATE TABLE IF NOT EXISTS sesiones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id UUID NOT NULL REFERENCES asistentes_tickets(id) ON DELETE CASCADE,
  token_hash CHAR(64) UNIQUE NOT NULL,
  device_id VARCHAR(60),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_sesiones_token ON sesiones (token_hash);
CREATE INDEX IF NOT EXISTS idx_sesiones_ticket ON sesiones (ticket_id);

-- 9. Bitácora de restablecimientos de contraseña
-- Trazabilidad: quién del staff restableció a quién y cuándo.
CREATE TABLE IF NOT EXISTS password_resets_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id UUID REFERENCES asistentes_tickets(id) ON DELETE SET NULL,
  staff_nombre VARCHAR(100),
  punto_ayuda VARCHAR(80),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_resets_created ON password_resets_log (created_at DESC);

-- =============================================================================
-- 10. Consentimiento de los leads de la web (Ley 29733)
-- =============================================================================
-- Hay que poder demostrar que el consentimiento fue previo, informado y
-- expreso. Se guarda la marca, el momento y el texto que la persona aceptó,
-- porque ese texto puede cambiar con el tiempo.
ALTER TABLE leads_diagnostico ADD COLUMN IF NOT EXISTS consentimiento BOOLEAN DEFAULT false;
ALTER TABLE leads_diagnostico ADD COLUMN IF NOT EXISTS consentimiento_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE leads_diagnostico ADD COLUMN IF NOT EXISTS consentimiento_texto TEXT;

-- =============================================================================
-- 11. Consentimiento de los asistentes (Ley 29733)
-- =============================================================================
-- Se valida en el registro pero tambien hay que poder DEMOSTRARLO despues.
-- Se guarda la marca, el momento, el texto aceptado y por que via se recogio
-- (la persona en la web, o el staff en el Punto de Ayuda con el documento
-- delante).
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS consentimiento BOOLEAN DEFAULT false;
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS consentimiento_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS consentimiento_texto TEXT;
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS consentimiento_via VARCHAR(30);
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS acepta_marketing BOOLEAN DEFAULT false;

-- Quien creo el registro: 'web' (la propia persona) o 'staff' (registro rapido
-- en puerta). Sirve para auditar y para saber que fichas estan incompletas.
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS origen VARCHAR(20) DEFAULT 'web';
ALTER TABLE asistentes_tickets ADD COLUMN IF NOT EXISTS creado_por VARCHAR(100);

-- =============================================================================
-- 12. Puestos participantes (la dinamica de insignias)
-- =============================================================================
-- Cada puesto muestra su QR. El asistente lo escanea y gana UNA insignia de ese
-- puesto, que vale un ticket para el sorteo.
CREATE TABLE IF NOT EXISTS empresas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
  nombre VARCHAR(150) NOT NULL,
  rubro VARCHAR(60),
  emoji VARCHAR(16),
  color VARCHAR(9),
  descripcion TEXT,
  stand VARCHAR(30),
  condicion TEXT,                            -- que hay que hacer para ganarla
  -- Token del QR impreso en el puesto. Aleatorio, no adivinable.
  qr_token VARCHAR(64) UNIQUE NOT NULL,
  -- Codigo corto legible bajo el QR, como red de seguridad cuando la camara
  -- no lee (sol directo, pantalla sucia, permiso denegado).
  codigo_corto VARCHAR(20) UNIQUE NOT NULL,
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_empresas_evento ON empresas (evento_id);
CREATE INDEX IF NOT EXISTS idx_empresas_qr ON empresas (qr_token);

-- =============================================================================
-- 13. Insignias obtenidas
-- =============================================================================
-- La regla antifraude vive AQUI, en un indice unico, no en el navegador:
-- una insignia por persona y puesto. Volver a escanear el mismo QR no suma.
-- Antes esto se comprobaba en localStorage, asi que cualquiera con la consola
-- del navegador podia darse tickets de sorteo.
CREATE TABLE IF NOT EXISTS insignias (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES asistentes_tickets(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  -- Numero correlativo del ticket de sorteo. Lo asigna el servidor: si lo
  -- calculara el cliente, se podria pedir el numero que uno quisiera.
  ticket_sorteo INT,
  device_id VARCHAR(60),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT insignia_unica_por_puesto UNIQUE (ticket_id, empresa_id)
);

CREATE INDEX IF NOT EXISTS idx_insignias_ticket ON insignias (ticket_id);
CREATE INDEX IF NOT EXISTS idx_insignias_empresa ON insignias (empresa_id);

-- =============================================================================
-- 14. Bitacora de escaneos
-- =============================================================================
-- Se registra TODO intento, valido o no. Sirve para detectar el fraude que el
-- indice unico no puede frenar: si el QR de un puesto se filtra por WhatsApp,
-- aqui se ve como cientos de personas lo escanean en pocos minutos desde
-- dispositivos distintos sin pasar por el stand.
CREATE TABLE IF NOT EXISTS scans_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
  ticket_id UUID REFERENCES asistentes_tickets(id) ON DELETE SET NULL,
  empresa_id UUID REFERENCES empresas(id) ON DELETE SET NULL,
  resultado VARCHAR(30) NOT NULL,   -- ok, duplicado, sin_ingreso, qr_invalido
  device_id VARCHAR(60),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scans_created ON scans_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scans_empresa ON scans_log (empresa_id, created_at DESC);
