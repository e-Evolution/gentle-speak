---
title: Voces
parent: Español
nav_order: 3
lang: es
translation: voices.md
---

# Voces
{: .no_toc }

1. TOC
{:toc}

---

## Los motores

| Motor | Necesita | Ofrece |
|-------|----------|--------|
| **Piper** mediante sherpa-onnx | El runtime nativo (unos 18 MB) y un paquete de voz (`es_MX` unos 67 MB; `es_ES` opcional) | Local y rápido, sin clonación. Voces fijas `es_MX` (la predeterminada) y `es_ES` |
| **Qwen3-TTS** mediante mlx-audio | macOS en Apple Silicon, el propio entorno de Python de gentle-speak, el modelo Base 0.6B (y VoiceDesign 1.7B para diseñar una voz) | Clona un WAV de referencia en cada frase: tus propias voces o las voces que diseñaste |
| **Voz del sistema** (`say`, `spd-say`, `espeak-ng`, SAPI) | Nada que descargar | Una voz más, y el respaldo automático |

**Otros motores y modelos todavía no están soportados.** Aun así, puedes usar una voz creada con otra herramienta; consulta [Importar una voz creada en otro lugar](#importar-una-voz-creada-con-otra-herramienta).

### Piper

Las voces Piper están en español: `es_MX` (Español (México), incluida en la instalación inicial) y `es_ES` (Español (España), opcional). Sintetizan en el proceso de audio con sherpa-onnx, sin Python.

### Qwen3-TTS

No se incluye ninguna voz Qwen. Las voces Qwen siempre son tuyas: diseñadas a partir de una descripción o clonadas de una grabación. Para hablar se usa siempre el modelo Base 0.6B con el audio de referencia de tu voz y su transcripción exacta. Consulta [Cómo se usan los modelos Qwen](arquitectura.md#cómo-se-usan-los-modelos-qwen).

### Voz del sistema

- macOS usa `say`.
- Linux usa `spd-say` si está disponible; si no, `espeak-ng` o `espeak`.
- Windows usa SAPI mediante `powershell.exe`, que debe estar en el `PATH`.

El texto siempre viaja por la entrada estándar, nunca por la línea de comandos.

`/speak` → **Voz del sistema** enumera las voces en español de la plataforma, y además `Auto`. `Auto` elige Paulina y después Mónica en macOS; Sabina y después Helena en Windows; y una voz de español latinoamericano y después `es` en Linux. En los menús, la voz se llama `Mac` en macOS y `Sistema` en el resto; su identificador siempre es `mac`.

La voz del sistema también es el **respaldo**. Cuando la voz Piper o Qwen seleccionada no está instalada o falla, gentle-speak habla con la voz del sistema y te avisa una vez por sesión. Una parada o una cancelación nunca recurren al respaldo. Desactívalo con `/speak` → **Toggle Mac fallback** (activar o desactivar el respaldo con la voz del sistema).

## Elegir una voz

- `/speak` enumera cada voz como `Voice: <label> (<id>) — installed` o `— not installed` (instalada o no instalada). Elige una ahí.
- Pulsa `cycleVoice` (`ctrl+alt+n`) para cambiar a la siguiente voz disponible.
- Para Gentle Dot, usa `/speak` → **Gentle Dot** → **Voz de Dot**.

Si eliges una voz Piper que todavía no está instalada, la elección se guarda y se te indica que ejecutes `/speak` → **Install voice and runtime** (instalar la voz y el runtime).

## Tu propia voz

Las voces Qwen necesitan macOS en Apple Silicon y las partes de Qwen de la instalación (`/speak` → **Instalar todo**). Tres opciones de `/speak` las gestionan:

| Opción | Qué hace |
|--------|----------|
| **Crear voz propia…** | Diseña una voz a partir de una descripción en texto, con VoiceDesign |
| **Importar mi grabación…** | Clona una grabación de tu voz, tras una confirmación explícita de consentimiento |
| **Borrar voz propia…** | Borra una de tus voces, tras una confirmación |

Tus voces aparecen como `Propia · <label>` en la lista de voces de `/speak`, en `cycleVoice` y en el selector de voz de Dot. Se seleccionan como `custom:<id>`.

### Diseñar una voz a partir de una descripción

`/speak` → **Crear voz propia…**

1. La primera vez, pide descargar el modelo VoiceDesign (`mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16`, unos 4.5 GB) desde Hugging Face a tu caché. No se descarga nada a menos que lo confirmes. Este modelo solo se usa para diseñar; para hablar se sigue usando el modelo Base.
2. Describe la voz en 10 a 600 caracteres, por ejemplo «femenina, adulta, cálida, acento mexicano».
3. Dale un nombre de hasta 40 caracteres.
4. Escribe una frase de muestra de 40 a 400 caracteres, o déjala vacía para usar la sugerida. La muestra se pronuncia una vez para crear el audio de referencia, que debe durar entre 3 y 30 segundos.

Diseñar carga el modelo y puede tardar alrededor de un minuto; se te avisa cuando termina. Una voz diseñada usa solo tu texto, nunca el audio de nadie.

### Clonar tu propia grabación

`/speak` → **Importar mi grabación…**

1. Confirma el consentimiento: «Es mi voz o tengo consentimiento explícito de la persona». Sin él, no se importa nada.
2. Indica la ruta de un archivo WAV. Debe ser una ruta absoluta o empezar por `~/`.
3. Escribe la **transcripción exacta** de lo que se dice en la grabación (de 1 a 500 caracteres).
4. Dale a la voz un nombre de hasta 40 caracteres.

La grabación debe ser:

- un WAV PCM (8, 16, 24 o 32 bits, de 8 a 192 kHz);
- de entre **3 y 30 segundos**;
- de 32 MiB como máximo.

Un WAV mono de 16 bits se copia tal cual. Cualquier otro WAV se convierte a mono de 16 bits con `ffmpeg`, que en ese caso debe estar instalado. La referencia guardada ocupa 16 MiB como máximo.

{: .advertencia }
Nunca clones la voz de una persona real sin su consentimiento.

### Importar una voz creada con otra herramienta

gentle-speak no ejecuta otros motores de texto a voz, pero Qwen puede clonar cualquier audio de referencia. Exporta una muestra desde la otra herramienta como WAV (de 3 a 30 segundos, con su transcripción exacta) e impórtala con «Importar mi grabación…». Se aplica la misma regla de consentimiento.

### Dónde se guardan tus voces

Cada voz se guarda en `~/.gentle-speak/voices/custom/<id>/`:

- `reference.wav`, el audio de referencia;
- `voice.json`, con el identificador, la etiqueta, la transcripción, la descripción, el idioma, el origen (`designed` o `recorded`), la fecha de creación y el **sha256** del audio.

El sha256 se comprueba cada vez que se usa la voz. Una voz que falta o no es válida se omite con un aviso, y una voz seleccionada que falta recurre al respaldo como cualquier voz que falte.

Tus voces se quedan en tu máquina y nunca se suben.

### Borrar una voz

`/speak` → **Borrar voz propia…**, elige la voz y confirma. No se puede deshacer. Si la voz borrada estaba seleccionada, la voz vuelve a la predeterminada, `es_MX`.

## Voces de versiones anteriores

Las versiones anteriores incluían siete voces de referencia `qwen-*`. En el siguiente inicio de sesión, una instalación existente de `voices/qwen3/` con un manifiesto válido se convierte una sola vez en voces propias, con la misma etiqueta, transcripción y sha256. Los WAV se copian y no se borra nada. Los ajustes que dicen `qwen-<name>` se asignan a `custom:<name>`, tanto en la terminal como en Dot.
