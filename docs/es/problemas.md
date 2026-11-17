---
title: Solución de problemas
parent: Español
nav_order: 8
lang: es
translation: troubleshooting.md
---

# Solución de problemas
{: .no_toc }

1. TOC
{:toc}

---

## Empieza por `/speak doctor`

Ejecuta `/speak doctor`, o `/speak` → **Doctor**. Hace 14 comprobaciones e imprime una línea por cada una:

- ✓ correcta;
- ✗ un problema, con una sugerencia de solución (→) en la línea siguiente;
- – no aplica aquí, o es opcional.

Todas las comprobaciones son de solo lectura: no se escribe, instala, inicia ni descarga nada. Cada comprobación tiene un límite de tiempo (8 segundos), y una comprobación que se cuelga o falla se indica como ✗ sin ocultar las demás. El informe termina con una línea de resumen, y después el doctor ofrece leer una frase de prueba («¿Probar una frase?»).

El informe está en español, como el menú `/speak`. Las etiquetas de abajo son las que ves.

| Comprobación | Qué revisa | Solución habitual |
|--------------|------------|-------------------|
| **Runtime de audio** | El runtime nativo de audio está instalado y verificado | `/speak` → «Instalar todo». Si no es válido, borra `~/.gentle-speak/runtime` y ejecuta «Instalar todo» |
| **Salida de audio** | El dispositivo de salida predeterminado se abre, con un flujo en silencio (sin sonido). Necesita el runtime | Revisa el dispositivo de salida del sistema (Bluetooth conectado, volumen) |
| **Modelos Piper** | La voz `es_MX` (obligatoria) y `es_ES` (opcional) | «Instalar todo» |
| **Entorno Python + mlx-audio** | Solo Apple Silicon. El entorno de Python registrado existe, importa `mlx_audio` y se instaló con las dependencias actuales bloqueadas por hash | «Instalar todo». Necesita `uv` o Python 3.12+ (`brew install python@3.12`) |
| **Modelo Qwen Base 0.6B (caché)** | Solo Apple Silicon. El modelo Base está en la caché de Hugging Face | «Instalar todo» |
| **Modelo VoiceDesign (opcional)** | Solo Apple Silicon. El modelo VoiceDesign está en la caché. Opcional: – si falta | Se descarga cuando usas «Crear voz propia…» |
| **Voces propias (sha256)** | Tus propias voces, cada una comprobada con su sha256 | Borra la que no sea válida con «Borrar voz propia…» y vuelve a crearla o importarla |
| **Voz elegida** | La voz seleccionada se puede usar | Elige otra voz con `/speak`, o ejecuta «Instalar todo» |
| **Servicio Qwen compartido** | Solo Apple Silicon. El socket, el pid, la versión y la compilación del servicio compartido, leídos sin conectarse a él | La siguiente vez que se use Qwen se arregla un socket desactualizado; o «Detener servicio Qwen» |
| **Cerrojo de voz** | El cerrojo de voz: libre, en manos de un proceso vivo o dejado por uno muerto (se recupera en la siguiente lectura) | No hay que hacer nada |
| **ffmpeg** | `ffmpeg` está en el `PATH` (solo se necesita para cambiar la velocidad de las voces Qwen) | `brew install ffmpeg` en macOS, `winget install ffmpeg` en Windows, `sudo apt install ffmpeg` en Linux |
| **Voz del sistema** | El motor de voz del sistema de la plataforma y sus voces en español | macOS: añade una voz en español en System Settings → Accessibility → Spoken Content (Ajustes del Sistema → Accesibilidad → Contenido leído). Linux: `sudo apt install speech-dispatcher espeak-ng`. Windows: añade un idioma español en Settings → Time & Language → Speech (Configuración → Hora e idioma → Voz) |
| **Fuente de foco** | De dónde viene el foco: eventos de foco de la terminal, Herdr o desconocido (–) | Dentro de tmux, `set -g focus-events on` |
| **Conexión con Gentle Dot** | Dot no está instalado (–), está instalado pero no conectado (–), conectado (✓), o su `settings.json` está mal formado (✗) | Corrige a mano un archivo mal formado; gentle-speak nunca lo toca |

Las comprobaciones de Qwen muestran – en cualquier sistema que no sea macOS en Apple Silicon.

## Problemas frecuentes

### No se lee nada

- La lectura automática está apagada por defecto. Enciéndela con `ctrl+alt+m` o con `/speak` → **Toggle auto-speak** (activar o desactivar la lectura automática), y revisa la fila SPEAK.
- En el modo `questions-and-results`, la simple narración se omite a propósito. Prueba `/speak` → **Mode: all** (modo: todo).
- En el modo `summary`, no se lee nada hasta que eliges un modelo con `/speak` → **Summary model** (el modelo del resumen). Mientras tanto, la fila SPEAK muestra `modo resumen sin modelo`.
- Nunca se leen los turnos que llaman a herramientas, ni los bloques de código, los diffs o la salida de herramientas.

### No hay sonido cuando el panel no tiene el foco

Es el aplazamiento por foco: el resultado más reciente se guarda hasta que pones el foco en el panel. Si no se sabe qué tiene el foco, las sesiones hablan por turnos, empezando por el nombre del proyecto. Consulta [Foco](uso.md#foco-con-varios-paneles).

### «Qwen synthesis failed»

Este mensaje significa que falló la síntesis con Qwen. Normalmente se debe a un servicio compartido desactualizado. Ahora, un servicio compilado a partir de otro código se sustituye automáticamente. Si no:

1. Ejecuta `/speak` → **Detener servicio Qwen** y vuelve a leer.
2. Si persiste, comprueba con `/speak doctor` que mlx-audio y el modelo Base están instalados.
3. Lee `~/.gentle-speak/qwen-service.log`.

### Auriculares Bluetooth

La reproducción usa la frecuencia de muestreo propia del dispositivo y tolera los vaciados del búfer (xruns) que puede producir el Bluetooth. Aun así, puede que oigas pequeños cortes. Un fallo se indica con `Audio playback failed: <cause>` (falló la reproducción de audio, con su causa).

### `/reload` hace que Gentle Shell se cierre de golpe

Es un problema de Gentle Shell (gentle-shell#2580 en la 4.7.0), no de gentle-speak. Reinicia Gentle Shell en su lugar (por ejemplo, `gentle-shell -r` para reanudar tu sesión), también después de instalar el paquete o de cambiar una tecla.

### El entorno de Python aparece como desactualizado

Un entorno instalado por una versión anterior, sin las dependencias actuales bloqueadas por hash, lo señala el doctor y se vuelve a ofrecer en «Instalar todo». Los paquetes bloqueados se instalan en el mismo entorno.

### La instalación dice que no puede instalar el entorno de Python

Necesita `uv` o Python 3.12 o posterior, y gentle-speak nunca instala paquetes del sistema. Instala uno de ellos (por ejemplo `brew install python@3.12` o `brew install uv`) y vuelve a ejecutar `/speak` → «Instalar todo».

### La voz del sistema no suena en Linux o Windows

Instala las herramientas indicadas en [Plataformas](plataformas.md#notas-por-plataforma). Estos casos no están verificados en vivo. En Windows, la voz necesita `powershell.exe` en el `PATH`; si no, el doctor indica «falta `powershell.exe` en el PATH».

### `spd-say` sigue hablando en Linux después de detenerlo

Detener (y un tiempo de espera agotado) mata `spd-say` y después ejecuta `spd-say -C`, que cancela todo lo que speech-dispatcher tenga en cola, incluida la voz de otras aplicaciones. No verificado en vivo.

### La lectura de lo copiado no hace nada

La lectura de lo copiado (no el resto de gentle-speak) necesita macOS y la TUI a pantalla completa, y solo lee texto que seleccionas y copias en este Gentle Shell mientras la terminal es la aplicación en primer plano. Cuando no puede funcionar, ves un aviso como «Speak copied selection is unavailable in this terminal mode (fullscreen required).» (la lectura de la selección copiada no está disponible en este modo de terminal; requiere pantalla completa).

## Registros

| Archivo | Qué contiene |
|---------|--------------|
| `~/.gentle-speak/qwen-service.log` | El registro del servicio Qwen compartido, con su versión y su compilación al iniciarse |
| `~/.gentle-speak/focus.log` | Una nota cuando no hay eventos de foco de la terminal |

El texto del portapapeles nunca se registra.

## ¿Sigues atascado?

Abre una incidencia en [GitHub](https://github.com/e-Evolution/gentle-speak/issues) con la salida de `/speak doctor`, tu plataforma y lo que esperabas. Para un problema de seguridad, sigue en su lugar la [política de seguridad](contribuir.md#reportar-una-vulnerabilidad).
