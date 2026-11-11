/** Voice catalog data: Piper (sherpa-onnx) locales and Qwen3-TTS reference-audio voices (S6). */
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
/** A Qwen3-TTS voice clones `file` (reference audio) using its exact `transcript`. */
export interface QwenVoice { engine: 'qwen3'; label: string; file: string; transcript: string; sha256: string; bytes: number }
/** The macOS system voice (`say`): no download, no runtime; the concrete voice is the `macVoice` setting. */
export interface SystemVoice { engine: 'system'; label: string }
export type CatalogVoice = PiperVoice | QwenVoice | SystemVoice;

export const QWEN_VOICES: Readonly<Record<string, QwenVoice>> = {
  "qwen-suave": { engine: 'qwen3', label: "Suave", file: "f3-suave.wav", transcript: "¿Ya estás despierto? Mira, te tengo una noticia buena y una mala, y voy a empezar por la buena, porque me cae bien tu cara. Terminé todo. Sí, todo, y sin quejarme ni una sola vez... bueno, casi ninguna. Ahora la mala: vas a tener que revisar lo que hice, y sé que eso te da pereza. Ven, siéntate. Escúchame un segundo y me dices si te convence, ¿va?", sha256: "d2bddd57ef9268065b53b7c42a6d1051a438e00c1c519bb9cac275699ca3a48a", bytes: 1080130 },
  "qwen-brisa": { engine: 'qwen3', label: "Brisa", file: "f2-brisa.wav", transcript: "¿Ya estás despierto? Mira, te tengo una noticia buena y una mala, y voy a empezar por la buena, porque me cae bien tu cara. Terminé todo. Sí, todo, y sin quejarme ni una sola vez... bueno, casi ninguna. Ahora la mala: vas a tener que revisar lo que hice, y sé que eso te da pereza. Ven, siéntate. Escúchame un segundo y me dices si te convence, ¿va?", sha256: "06c7fcebab6715a5bcbb9c60b50da4d2c2d69c82cba33d0abeaaadd3dfb586f0", bytes: 1080694 },
  "qwen-coqueta": { engine: 'qwen3', label: "Coqueta", file: "qwen3-vd-v3h-x.wav", transcript: "¿Ya estás despierto? Mira, te tengo una noticia buena y una mala, y voy a empezar por la buena, porque me cae bien tu cara. Terminé todo. Sí, todo, y sin quejarme ni una sola vez... bueno, casi ninguna. Ahora la mala: vas a tener que revisar lo que hice, y sé que eso te da pereza. Ven, siéntate. Escuchame un segundo y me decis si te convence, ¿va?", sha256: "89dca671b7d0d49b0a6c3fa0e7abccced663c9a4ce0ecb3754aeb4e91806a745", bytes: 1662764 },
  "qwen-maestra": { engine: 'qwen3', label: "Maestra", file: "qwen3-vd-v3h-t1.wav", transcript: "¿Ya estás despierto? Mira, te tengo una noticia buena y una mala, y voy a empezar por la buena, porque me cae bien tu cara. Terminé todo. Sí, todo, y sin quejarme ni una sola vez... bueno, casi ninguna. Ahora la mala: vas a tener que revisar lo que hice, y sé que eso te da pereza. Ven, siéntate. Escuchame un segundo y me decis si te convence, ¿va?", sha256: "c4610abc3b8acabf631d6ac5eeb3f9bb2256036619af3286360c39cb127e348e", bytes: 1731884 },
  "qwen-intima": { engine: 'qwen3', label: "Íntima", file: "qwen3-chain-l3.wav", transcript: "Encontré el problema. Era una carrera en el worker de audio, algo tonto en realidad. Ya está arreglado.", sha256: "9a4523fa9358accfb20bafc8c04d42c4b00a0356fe41e18204dce6e4bd27e327", bytes: 364844 },
  "qwen-serena": { engine: 'qwen3', label: "Serena", file: "qwen3-vd-v3h-t1-frio3.wav", transcript: "Encontré el problema. Era una carrera en el worker de audio, algo tonto en realidad. Ya está arreglado.", sha256: "79518f55c129eba1df27226b99ad1f136a7ef3f14dc56e162869c1a934db4219", bytes: 430124 },
  "qwen-viva": { engine: 'qwen3', label: "Viva", file: "qwen3-vd-v3h-t1-s7-linea3.wav", transcript: "Encontré el problema. Era una carrera en el worker de audio, algo tonto en realidad. Ya está arreglado.", sha256: "2461137825aab2f80d88bcd3787e88e3a4e71d19060cb70738ed8172c8070cbf", bytes: 564524 },
};

/** A locale-keyed catalog; adding a voice does not change the persisted settings format. */
export const VOICE_CATALOG: Record<string, CatalogVoice> = {
  es_MX: { engine: 'piper', locale: 'es_MX', language: 'es', label: 'Español (México)' },
  es_ES: { engine: 'piper', locale: 'es_ES', language: 'es', label: 'Español (España)' },
  ...QWEN_VOICES,
  mac: { engine: 'system', label: 'Mac' },
};
