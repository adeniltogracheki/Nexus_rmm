-- Adiciona tipos de dispositivo mobile/tablet ao enum tipo_maquina
-- Necessário para agentes Android (Nexus RMM v0.7.0)
ALTER TYPE "public"."tipo_maquina" ADD VALUE IF NOT EXISTS 'mobile';
ALTER TYPE "public"."tipo_maquina" ADD VALUE IF NOT EXISTS 'tablet';
