/**
 * Copyright (C) 2026, e-Evolution Consultants S.A. , http://www.e-evolution.com
 * SPDX-License-Identifier: MIT
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the MIT License. See the LICENSE file in the root of
 * this project for the full license text.
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * MIT License for more details.
 * Email: victor.perez@e-evolution.com, http://www.e-evolution.com , http://github.com/e-Evolution
 * Created by victor.perez@e-evolution.com , www.e-evolution.com
 */
/** Voice catalog data: Piper (sherpa-onnx) locales and the macOS voice (Qwen voices are the user's own, S14/S15). */
export const QWEN_MODEL_ID = 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16';
/** S14: the VoiceDesign model, used only to design a voice from text (a separate, explicit, confirmed download); speech keeps cloning with the Base model. */
export const QWEN_DESIGN_MODEL_ID = 'mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16';
/** S14: a custom voice is selected as `custom:<id>`; the id is also its directory name under `<sharedHome>/voices/custom/`. */
export const CUSTOM_VOICE_PREFIX = 'custom:';
export const CUSTOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const isCustomVoiceId = (value: unknown): value is string => typeof value === 'string' && value.startsWith(CUSTOM_VOICE_PREFIX) && CUSTOM_ID_PATTERN.test(value.slice(CUSTOM_VOICE_PREFIX.length));
/**
 * Interpreter flags for every Qwen python call: the installer's check and the
 * synth worker must agree, or a check can pass while the worker fails.
 * `-E` ignores PYTHON* env vars and `-P` keeps the script dir off sys.path.
 * Not `-I`: it implies `-s`, which drops the user site-packages where
 * mlx-audio's dependencies (e.g. `packaging`) are commonly installed.
 */
export const QWEN_PYTHON_FLAGS: readonly string[] = Object.freeze(['-E', '-P']);

export interface PiperVoice { engine: 'piper'; locale: string; language: string; label: string }
/** The macOS system voice (`say`): no download, no runtime; the concrete voice is the `macVoice` setting. */
export interface SystemVoice { engine: 'system'; label: string }
export type CatalogVoice = PiperVoice | SystemVoice;

/**
 * T45 (S15): the public catalog has no Qwen voices. They come only from the user (`custom:<id>`, S14). The ids the first releases shipped are kept only so
 * a settings file that still says `qwen-<name>` keeps loading (it then falls back as a missing voice, or is converted by the one-time migration).
 */
export const LEGACY_QWEN_VOICE_IDS: readonly string[] = Object.freeze(['qwen-suave', 'qwen-brisa', 'qwen-coqueta', 'qwen-maestra', 'qwen-intima', 'qwen-serena', 'qwen-viva']);
export const isLegacyQwenVoiceId = (value: unknown): value is string => typeof value === 'string' && LEGACY_QWEN_VOICE_IDS.includes(value);

/** A locale-keyed catalog; adding a voice does not change the persisted settings format. */
export const VOICE_CATALOG: Record<string, CatalogVoice> = {
  es_MX: { engine: 'piper', locale: 'es_MX', language: 'es', label: 'Español (México)' },
  es_ES: { engine: 'piper', locale: 'es_ES', language: 'es', label: 'Español (España)' },
  mac: { engine: 'system', label: 'Mac' },
};
