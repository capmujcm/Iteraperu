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
