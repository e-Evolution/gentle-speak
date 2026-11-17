---
title: Instalación
parent: Español
nav_order: 1
lang: es
translation: installation.md
---

# Instalación
{: .no_toc }

1. TOC
{:toc}

---

## Requisitos

Tú aportas:

- **Gentle Shell (Pi)** y **Node.js 24 o posterior**.
- **Para las voces Qwen:** macOS en Apple Silicon, y `uv` **o** Python 3.12 o posterior. Si no tienes ninguno, la instalación te indica cómo instalar uno (por ejemplo `brew install python@3.12` o `brew install uv`) y no instala nada del sistema por ti.
- **Opcional:** `ffmpeg`, que solo se usa para cambiar la velocidad de las voces Qwen. La instalación lo detecta y muestra una sugerencia para instalarlo (`brew install ffmpeg` en macOS). Nunca instala paquetes del sistema.
- **Voz del sistema en Linux:** `sudo apt install speech-dispatcher espeak-ng`. macOS y Windows no necesitan nada más para la voz del sistema.

Todo lo demás lo descarga la instalación, después de que lo confirmes. Consulta [Qué instala](#qué-instala).

## Instalar el paquete

Elige un origen.

### Desde npm (cuando esté publicado)

El paquete todavía no está en npm. Cuando se publique:

```bash
gentle-shell install npm:@e-evolution/gentle-speak
```

### Desde GitHub

```bash
gentle-shell install git:github.com/e-Evolution/gentle-speak
```

Pi documenta los orígenes git como `git:<host>/<owner>/<repo>` con un sufijo opcional `@<ref>` (una etiqueta o una rama), y también la forma `https://<host>/<owner>/<repo>`. Por ejemplo, para fijar una etiqueta:

```bash
gentle-shell install git:github.com/e-Evolution/gentle-speak@<tag>
```

### Desde una copia local

```bash
git clone https://github.com/e-Evolution/gentle-speak.git
cd gentle-speak && npm ci
gentle-shell install ./
```

### Probarlo sin instalarlo

Desde una copia local, puedes cargar la extensión solo para una sesión:

```bash
gentle-shell -- -e ./extensions/gentle-speak.ts
```

## Reiniciar Gentle Shell

Si Gentle Shell ya estaba abierto, reinícialo con:

```bash
gentle-shell -r
```

`gentle-shell -r` reanuda una sesión con el paquete de Gentle Shell cargado; `gentle-shell -c` continúa la última. Un `pi` a secas inicia Pi estándar con su propio directorio personal (`~/.pi`), no el de Gentle Shell.

No uses `/reload` para esto: puede hacer que Gentle Shell 4.7.0 se cierre de golpe (gentle-shell#2580). Es un problema de Gentle Shell, no de gentle-speak.

## Instalación en el primer arranque

Pi instala paquetes sin ejecutar scripts de instalación, así que gentle-speak se instala a sí mismo en el **primer arranque en la terminal**. Nada sale a la red antes de que lo confirmes.

1. gentle-speak muestra **una sola confirmación**, titulada «Instalar todo», que enumera lo que falta, el tamaño de cada parte y el total. Los tamaños son valores fijados, no consultados en línea.
2. Si aceptas, instala las partes una a una en segundo plano, con avisos de progreso. Un fallo detiene solo esa parte; las demás se instalan igualmente, salvo el modelo Qwen, que necesita el entorno de Python. Termina con «gentle-speak listo» cuando todo se instaló, o con «gentle-speak: instalación incompleta.» y una línea ✓ / ✗ / – por parte.
3. Si la rechazas, el rechazo se recuerda (`setupOffer: "declined"` en el archivo de ajustes) y no se te vuelve a preguntar al arrancar.

Puedes ejecutar la misma instalación en cualquier momento con `/speak` → **Instalar todo**. Cuando no falta nada, te lo dice.

En Apple Silicon, cuando Qwen está listo y todavía no tienes una voz propia, la instalación te sugiere `/speak` → «Crear voz propia…». Consulta [Voces](voces.md).

### Qué instala

| Parte | Tamaño | Dónde |
|-------|--------|-------|
| Runtime nativo de audio (sherpa-onnx + node-cpal) | unos 18 MB | `~/.gentle-speak/runtime/` |
| Voz Piper `es_MX` | unos 67 MB | `~/.gentle-speak/models/` |
| Entorno de Python con `mlx-audio==0.4.4` y sus dependencias bloqueadas por hash (solo Apple Silicon) | unos 480 MB en disco | `~/.gentle-speak/python/` |
| Modelo Qwen3-TTS Base 0.6B (solo Apple Silicon) | unos 2.5 GB | Caché de Hugging Face (`HF_HOME`, por defecto `~/.cache/huggingface`) |

Notas:

- El tamaño del runtime depende de tu plataforma; la confirmación muestra el tamaño fijado exacto.
- El entorno de Python se crea con `uv`, o si no con `python3 -m venv`. No necesita `sudo` y no toca el Python de tu sistema.
- El modelo **VoiceDesign 1.7B** (unos 4.5 GB) **nunca** forma parte de la instalación. Solo se descarga si eliges «Crear voz propia…» y confirmas esa descarga.
- La voz Piper de español de España, `es_ES`, es opcional. Selecciónala como tu voz y luego usa `/speak` → **Install voice and runtime** (instalar la voz y el runtime).
- Cada descarga se verifica. Los paquetes del runtime y los paquetes de voces Piper tienen hashes fijados, y los paquetes de Python se instalan con `--require-hashes`.

Para saber de dónde viene cada descarga, consulta [Privacidad y seguridad](privacidad.md).

## Comprobar la instalación

Ejecuta:

```text
/speak doctor
```

Ejecuta 14 comprobaciones de solo lectura y marca cada una con ✓ (correcta), ✗ (problema, con una sugerencia de solución) o – (no aplica, u opcional). Al final ofrece una prueba hablada. Consulta [Solución de problemas](problemas.md).

## Encender la voz

La lectura automática está apagada por defecto. Enciéndela con `ctrl+alt+m`, o con `/speak` → **Toggle auto-speak** (activar o desactivar la lectura automática). Consulta [Uso](uso.md).

## Dónde van los archivos

Los archivos propios de gentle-speak viven en `~/.gentle-speak/`. Los modelos Qwen viven en la caché de Hugging Face, y pip o uv mantienen sus cachés de descarga habituales. Consulta [Arquitectura](arquitectura.md#la-carpeta-de-gentle-speak) para ver la estructura completa.
