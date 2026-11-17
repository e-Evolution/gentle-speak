---
title: Hardware, tokens y velocidad
parent: Español
nav_order: 8
lang: es
translation: requirements.md
---

# Hardware, tokens y velocidad
{: .no_toc }

Qué necesita cada voz, qué suma la extensión a tu consumo de tokens y qué tan rápido habla. Las cifras están marcadas como **medido** (tomado en una máquina real) o **estimación** (derivada del código o de una regla práctica).

1. TOC
{:toc}

---

## Hardware

Los tamaños en disco están en [Qué instala](instalacion.md#qué-instala); no se repiten aquí.

| Voz | Funciona en | Memoria | Descarga (ver la tabla) |
|-----|-------------|---------|--------------------------|
| **Piper** (`es_MX`, `es_ES`) | CPU, con sherpa-onnx. macOS, Linux y Windows (solo macOS en Apple Silicon se ha probado en vivo; consulta [Plataformas](plataformas.md)) | **Medido:** el proceso de síntesis llegó a unos 0.3 GB con una frase y a unos 0.55 GB con un texto de 600 caracteres | Runtime unos 18 MB, voz unos 67 MB |
| **Qwen3-TTS Base 0.6B** (tus voces propias) | **Solo Apple Silicon**, con MLX. Necesita Python 3.12 o posterior (o `uv`) | Unos 2.6 GB, cargados **una sola vez** y compartidos por todas tus sesiones, no una vez por sesión (según [Arquitectura](arquitectura.md#el-servicio-qwen-compartido)) | Modelo unos 2.5 GB, entorno de Python unos 480 MB |
| **VoiceDesign 1.7B** (solo para diseñar una voz) | Solo Apple Silicon | **No medido.** Es un modelo más grande que Base, así que cabe esperar que necesite más de 2.6 GB de memoria mientras diseñas una voz | Unos 4.5 GB, solo si lo confirmas |
| **Voz del sistema** | `say` en macOS; las herramientas de Linux y Windows no se han probado en vivo | La aporta el sistema operativo; **no medido** | Nada |

Todas las voces necesitan **Node.js 24 o posterior**.

**Mínimo y recomendado (a partir de los datos anteriores):**

- **Solo Piper:** cualquier máquina que ejecute Gentle Shell en una plataforma compatible. Unos 85 MB de disco y bastante menos de 1 GB de memoria para sintetizar.
- **Voces Qwen:** un Mac con Apple Silicon con unos 2.6 GB de memoria libres para el modelo compartido, unos 3 GB de disco para el modelo y su entorno, y Python 3.12 o posterior. No hemos medido qué chips ni tamaños de memoria de Apple Silicon van holgados; no se indica un chip mínimo porque no se probó ninguno.
- **Diseñar una voz:** suma unos 4.5 GB de disco. La memoria libre necesaria no se midió.

## Tokens

Son **estimaciones**. El método: un token equivale a unos 4 caracteres en inglés y a unos 3 o 4 en español, así que los caracteres divididos entre 3 o 4 dan el número de tokens. El tokenizador de tu modelo puede diferir.

| Función | Llamadas extra al modelo | Tokens que suma |
|---------|--------------------------|-----------------|
| Lectura automática en `all` y `questions-and-results` | **0** | **0.** Reutiliza el texto final que el agente ya escribió. |
| Atajos, menú `/speak` y lectura de lo copiado | **0** | **0** |
| La **definición** de la herramienta `speak` | 0 | Fijos: **253 caracteres**, unos **65 tokens de entrada** a 4 caracteres por token, en **cada** petición al modelo de una sesión que tiene la extensión. El envoltorio propio del proveedor puede sumar un poco. |
| Una **llamada** a `speak` | 0 extra (es una llamada a herramienta dentro del turno) | El texto que le pides decir, como **tokens de salida**: hasta 4000 caracteres, es decir, unos 1000 a 1300 tokens como máximo. La herramienta responde con un texto corto como «Speech completed.» (unos pocos tokens). |
| **Modo resumen** | **1 por resultado leído** | Ver abajo. |

Por qué la lectura automática no cuesta nada: la extensión solo lee la conversación terminada cuando la ejecución se asienta, la filtra y la lee en voz alta. Nunca envía un mensaje, añade una entrada ni inyecta texto en el contexto del modelo.

### Modo resumen, por resultado

Cada resultado que se lee hace una llamada extra al modelo de resumen que elegiste:

- **Entrada:** una instrucción de una línea (unos 40 tokens) más **como máximo 2000 caracteres** del resultado, es decir, unos 500 a 670 tokens. En total, unos **40 a 700 tokens de entrada**, según lo largo que sea el resultado.
- **Salida:** **como máximo 80 tokens** (`maxTokens: 80`); una frase corta suele ser bastante menos.
- **Caché:** la llamada usa `cacheRetention` en `none`, así que no conserva caché de prompt.

Un modelo local no gasta tokens de un plan de pago. Si la llamada falla, no se lee nada y nunca se recurre al texto sin resumir.

### Qué sesiones pagan la definición de la herramienta

La herramienta `speak` se registra siempre que la extensión se carga, en **todas** las sesiones que la cargan, incluidas las sesiones hijas y RPC, así que cada una paga los tokens de la definición. Solo **funciona** en la sesión padre interactiva de la terminal y en la sesión del motor de Gentle Dot; en las demás, una llamada devuelve «Speech requires an interactive parent TUI session.» Si no quieres ese coste, no cargues la extensión en esas sesiones.

## Velocidad

| Qué | Valor |
|-----|-------|
| Piper, una frase (57 caracteres, unos 4 s de audio) | **Medido:** unos 0.21 s en sintetizarse, un factor de tiempo real de unos 0.05 (unas 20 veces más rápido que la reproducción) |
| Piper, 613 caracteres (unos 37 s de audio) | **Medido:** unos 2.2 s en sintetizarse, un factor de tiempo real de unos 0.06 |
| Piper, carga de la voz | **Medido:** unos 0.24 s |
| Qwen, partes en streaming | El audio se envía a medida que cada parte de unos 2 segundos está lista, así que no esperas al texto completo |
| Qwen, primer sonido | Unos 1.5 s con el modelo ya cargado (documentado en [Arquitectura](arquitectura.md#partes-en-streaming)); **no medido aquí** |
| Qwen, síntesis especulativa | Mientras la respuesta aún se escribe, las frases completas se sintetizan por adelantado, así que el primer sonido puede empezar antes (no en modo `summary`) |
| Qwen, arranque en frío | La primera carga del servicio compartido es más lenta que una carga en caliente; **no medido** |
| Qwen, tiempo cargado | El servicio compartido sigue cargado 10 minutos por defecto tras cerrarse la última sesión (`qwenIdleMinutes`); la siguiente locución, una vez descargado, paga un arranque en frío |

**Cómo se midieron las cifras de Piper:** en un Mac con Apple Silicon, en noviembre de 2026, con la voz `es_MX` instalada, la CPU, dos hilos y velocidad 1.0. Cada texto se ejecutó 3 veces en un proceso nuevo y la tabla muestra la mediana. Solo síntesis: no se reprodujo nada. El tiempo es el de la segunda llamada de síntesis de un proceso (la primera llamada de cada proceso quedó a menos de un 10 % aproximado de ella). Tu máquina será distinta. Las cifras de Qwen no se midieron porque habría implicado arrancar un servicio de modelo aparte; solo se dan los valores documentados.

Cambiar la velocidad de las voces Qwen necesita el `ffmpeg` opcional (consulta [Instalación](instalacion.md#requisitos)).
