---
title: Privacidad y seguridad
parent: Español
nav_order: 9
lang: es
translation: privacy.md
---

# Privacidad y seguridad
{: .no_toc }

1. TOC
{:toc}

---

## Todo se ejecuta en local

La síntesis, las voces y el servicio Qwen compartido se ejecutan en tu máquina. No se sube ningún audio ni ninguna voz.

La única excepción es un modo que tú eliges: el modo `summary` envía el texto final depurado (nunca la salida de herramientas) al modelo que **tú** eliges, que puede ser un proveedor en la nube con sus costes habituales. Si no eliges ningún modelo, no se envía nada.

## Nada de red antes de que confirmes

- Nada se descarga, se carga ni se inicia cuando arranca Pi.
- No se hace ninguna petición de red antes de la confirmación de la instalación. Los tamaños que muestra son valores aproximados fijados, no consultados en línea.
- Lo mismo vale para la descarga de VoiceDesign: su tamaño está fijado, y nada llega a Hugging Face antes de que confirmes.

## Qué se descarga y desde dónde

Solo después de tu confirmación:

| Qué | Desde dónde |
|-----|-------------|
| Runtime nativo de audio (sherpa-onnx, node-cpal) | El registro de npm, como tarballs fijados con hashes fijados |
| Paquetes de voces Piper | Las releases de sherpa-onnx en GitHub, como archivos fijados con hashes sha256 fijados |
| Paquetes de Python para Qwen (Apple Silicon) | PyPI, como un conjunto bloqueado por hash |
| Una compilación de CPython, solo cuando falta Python 3.12 | `uv`, en su propio directorio `~/.local/share/uv/python` |
| Modelos Qwen3-TTS Base y VoiceDesign | Hugging Face, en su caché |

Una descarga cuyo hash no coincide se rechaza.

### Dependencias de Python bloqueadas por hash

El entorno de Qwen instala `mlx-audio==0.4.4` y cada una de sus dependencias a partir de un archivo de bloqueo, `scripts/requirements-qwen.txt`. Cada paquete está fijado a una versión con sus hashes sha256 y se instala con `--require-hashes`. Un paquete cuyo hash no coincide se rechaza.

### Tu proyecto no puede dirigir los instaladores

- Los instaladores se ejecutan desde `~/.gentle-speak`, nunca desde tu proyecto actual.
- `uv` se ejecuta con `--no-config`.
- Un `uv.toml`, `pip/` o `venv/` en el directorio donde iniciaste Gentle Shell no puede cambiar lo que se instala.

### Qué más escribe la instalación

Además de `~/.gentle-speak`, la instalación escribe en las cachés de descarga de pip o uv y en la caché de Hugging Face (`HF_HOME`, por defecto `~/.cache/huggingface`).

## Voces y consentimiento

- **Las grabaciones importadas** necesitan una confirmación explícita de que la voz es tuya o de que tienes el permiso de la persona: «Es mi voz o tengo consentimiento explícito de la persona».
- **Las voces diseñadas** usan solo tu texto, nunca el audio de nadie.
- Tus voces se guardan en `~/.gentle-speak/voices/custom/` y nunca se suben.

## Qué nunca se lee en voz alta

- Los bloques de código, los diffs y la salida de herramientas.
- Los turnos que llaman a herramientas.
- Las sesiones RPC, print, JSON y las sesiones hijas delegadas (la sesión raíz de Gentle Dot es la única excepción, y solo cuando la conectas).
- La lectura de lo copiado omite el contenido oculto, transitorio y de gestores de contraseñas del portapapeles, y solo lee texto que copiaste desde este Gentle Shell. El texto del portapapeles nunca se guarda ni se registra.

## Archivos locales

- El archivo de ajustes se escribe de forma atómica con modo 0600.
- El servicio Qwen compartido escucha en un socket Unix privado, `~/.gentle-speak/qwen.sock` (modo 0600, en un directorio 0700).

## Reportar una vulnerabilidad

Por favor, no abras una incidencia pública para un problema de seguridad. Repórtalo de forma privada a través de GitHub: abre la pestaña **Security** (seguridad) del repositorio y elige **Report a vulnerability** (reportar una vulnerabilidad). Deberías recibir una primera respuesta en un plazo de 7 días.

Dentro del alcance:

- las descargas y sus hashes fijados, y la extracción de archivos comprimidos;
- la preparación del entorno de Python;
- el socket local del servicio Qwen en `~/.gentle-speak`;
- la importación de la grabación de voz de un usuario;
- cualquier cosa que pueda hacer que gentle-speak lea en voz alta, copie o envíe datos que no elegiste.

Las vulnerabilidades de los proyectos de origen (sherpa-onnx, mlx-audio, las voces Piper, los modelos Qwen3-TTS, Gentle Shell) corresponden a esos proyectos.

La política completa está en [SECURITY.md](https://github.com/e-Evolution/gentle-speak/blob/main/SECURITY.md) (en inglés).
