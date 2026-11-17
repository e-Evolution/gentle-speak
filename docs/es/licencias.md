---
title: Licencias
parent: Español
nav_order: 10
lang: es
translation: licenses.md
---

# Licencias
{: .no_toc }

1. TOC
{:toc}

---

## gentle-speak

gentle-speak se publica bajo la [licencia MIT](https://github.com/e-Evolution/gentle-speak/blob/main/LICENSE), Copyright (c) 2026 e-Evolution Consultants S.A.

Es una extensión comunitaria para Gentle Shell (gentle-pi, MIT), de Alan Buscaglia, que funciona sobre Pi, de Mario Zechner. **No está afiliada a Gentleman Programming**.

## Componentes de terceros

La lista completa, con la versión, la licencia, el origen y la relación con el paquete de cada componente, está en [THIRD_PARTY_NOTICES.md](https://github.com/e-Evolution/gentle-speak/blob/main/THIRD_PARTY_NOTICES.md) (en inglés). En resumen:

- **Incluido en el paquete:** el paquete solo contiene el propio código MIT de gentle-speak, más `seek-bzip` (MIT) como dependencia normal de npm.
- **Dependencias del anfitrión (peers):** los paquetes de Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) y el propio Gentle Shell, todos MIT, los aporta el anfitrión.
- **Descargados por ti, nunca redistribuidos:** el runtime (sherpa-onnx, onnxruntime, node-cpal), las voces Piper, mlx-audio y los modelos Qwen3-TTS. Los descargas de sus orígenes durante la instalación. Sus licencias son permisivas (Apache-2.0, MIT, ISC, CC0), y las fichas de los modelos (model cards) son la referencia para las voces y los modelos.
- **Programas externos:** `say`, `spd-say`, `espeak-ng`, Windows SAPI, `ffmpeg`, `uv`, Python y Herdr se ejecutan como procesos aparte que ya están en tu sistema.

| Componente | Licencia | Relación |
|------------|----------|----------|
| seek-bzip 2.0.0 | MIT | incluido |
| sherpa-onnx 1.13.8 | Apache-2.0 | descargado |
| node-cpal 1.0.0 | ISC | descargado |
| Piper `es_MX` (claude-high) | Apache-2.0 (conjunto de datos, según su ficha) | descargado |
| Piper `es_ES` (davefx) | CC0 (según su ficha) | descargado, opcional |
| mlx-audio 0.4.4 | MIT | descargado |
| Qwen3-TTS Base 0.6B y VoiceDesign 1.7B (conversiones a MLX) | Apache-2.0 (según sus fichas en Hugging Face) | descargado |
| espeak-ng, dentro de los binarios de sherpa-onnx | **GPL-3.0-or-later** | descargado, ver abajo |

## espeak-ng y GPL-3.0

Los binarios precompilados de sherpa-onnx incluyen **espeak-ng, que es GPL-3.0-or-later**, a través de piper-phonemize. El proyecto de origen lo sigue en [la incidencia #3731 de sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/issues/3731) y en [la incidencia #4053](https://github.com/k2-fsa/sherpa-onnx/issues/4053).

**Por qué gentle-speak sigue siendo MIT:** descargas el runtime tú mismo desde su paquete npm de origen. gentle-speak no lo empaqueta, no lo distribuye ni lo modifica, y lo ejecuta en un proceso aparte.

{: .advertencia }
Si empaquetas tú mismo el runtime de sherpa-onnx o el `espeak-ng-data` de los paquetes de voces Piper, o los redistribuyes junto con gentle-speak, asumes las obligaciones de la GPL-3.0. Esto no es asesoramiento legal.

## Pendiente de verificar

Algunas licencias todavía no se han verificado en su origen:

- el archivo de licencia de onnxruntime;
- las licencias de los crates de Rust de node-cpal;
- las licencias de las dependencias transitivas de mlx-audio;
- las licencias de las herramientas externas (`say`, `spd-say`, el comando `espeak-ng`, SAPI, `ffmpeg`, `uv`, Python, Herdr).

Trátalas como desconocidas hasta que se verifiquen. Las correcciones son bienvenidas como incidencias o pull requests.

## Créditos

- **seek-bzip**, el descompresor bzip2 que se usa para desempaquetar los paquetes de voces Piper.
- **Prince Canuma** y quienes contribuyen a **mlx-audio**, por la biblioteca de voz para MLX que ejecuta Qwen3-TTS en Apple Silicon.
- El **equipo de Qwen** (Alibaba Cloud), por Qwen3-TTS, y **mlx-community**, por las conversiones a MLX de los modelos Base y VoiceDesign.
- El proyecto **Piper**, los autores de las voces `es_MX` (claude) y `es_ES` (davefx) y de sus conjuntos de datos, y quienes mantienen **sherpa-onnx** (k2-fsa), por los paquetes convertidos y el runtime.
- **Pi**, de Mario Zechner y colaboradores, el agente de programación sobre el que funciona Gentle Shell.
- **Gentle Shell** (gentle-pi), de Alan Buscaglia (Gentleman Programming), el anfitrión para el que está hecha esta extensión.
- **gentle-ai**, de Gentleman Programming (MIT), que solo se usa como herramienta de desarrollo. No se incluye nada de él. gentle-speak se creó con gentle-ai.
