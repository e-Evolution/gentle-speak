---
title: Configuración
parent: Español
nav_order: 4
lang: es
translation: configuration.md
---

# Configuración
{: .no_toc }

1. TOC
{:toc}

---

## Usar `/speak`

`/speak` es la forma de cambiar los ajustes. Valida cada cambio y escribe el archivo por ti. Ejecuta `/speak` en la terminal interactiva y elige una opción. Las opciones aparecen con el texto que muestra el producto; entre paréntesis va su significado cuando la etiqueta está en inglés:

- **Gentle Dot**: el submenú de Gentle Dot (consulta [Gentle Dot](gentle-dot.md))
- **Toggle auto-speak** (activar o desactivar la lectura automática)
- **Mode: all**, **Mode: questions-and-results**, **Mode: summary** (modo: todo, preguntas y resultados, o resumen)
- **Summary model** (el modelo del resumen)
- **Voice: …** (voz): cada voz, con su estado (`installed` o `not installed`, instalada o no instalada)
- **Crear voz propia…**, **Importar mi grabación…**, **Borrar voz propia…** (consulta [Voces](voces.md))
- **Voz del sistema**
- **Toggle Mac fallback** (activar o desactivar el respaldo con la voz del sistema)
- **Mantener Qwen tras cerrar la última sesión**
- **Detener servicio Qwen** (solo aparece mientras el servicio Qwen compartido está en marcha)
- **Speed** (velocidad)
- **Key: speakLast**, **Key: stop**, **Key: toggle**, **Key: cycleVoice**, **Key: toggleCopy** (tecla de cada acción)
- **Install voice and runtime** (instalar la voz y el runtime): la voz Piper seleccionada y el runtime nativo, cada uno con su propia confirmación
- **Instalar todo**: la instalación completa (consulta [Instalación](instalacion.md#instalación-en-el-primer-arranque))
- **Doctor**: lo mismo que `/speak doctor`
- **Toggle speak copied selection** (activar o desactivar la lectura de la selección copiada)
- **Stop playback** (detener la reproducción)
- **Cancel** (cancelar)

Después de un cambio verás «Speech settings saved.» (ajustes de voz guardados). Los cambios de atajos necesitan un reinicio; consulta [Cambiar una tecla](uso.md#cambiar-una-tecla).

## El archivo de ajustes

Los ajustes se guardan en `speak-settings.json`:

- esquema `gentle-speak.settings/v1`;
- escrito de forma atómica, con modo de archivo 0600;
- un archivo que falta o está mal formado equivale a los valores por defecto, así que la voz queda **apagada**.

**Cada aplicación tiene su propio archivo.** Cada aplicación lee `$HOME/.gentle-speak/speak-settings.json`:

- el de la terminal es `~/.gentle-speak/speak-settings.json`;
- el de Gentle Dot es `<Dot HOME>/.gentle-speak/speak-settings.json` (consulta [Gentle Dot](gentle-dot.md#sus-propios-ajustes)).

Las partes descargadas, tus voces y el cerrojo de voz siempre se comparten desde el `~/.gentle-speak` real, así que nada se descarga dos veces.

{: .nota }
Mejor usa `/speak` que editar el archivo a mano. Un archivo con una clave desconocida, un tipo incorrecto o un valor no válido se ignora entero, y se aplican los valores por defecto.

## Ajustes

| Clave | Tipo | Por defecto | Significado |
|-------|------|-------------|-------------|
| `enabled` | booleano | `false` | Lectura automática encendida o apagada |
| `mode` | cadena | `questions-and-results` | `all`, `questions-and-results` o `summary` (consulta [Modos](uso.md#modos)) |
| `voice` | cadena | `es_MX` | `es_MX`, `es_ES`, `mac` (la voz del sistema) o `custom:<id>` |
| `speed` | número | `1` | Velocidad de la voz, de 0.5 a 2 |
| `summaryModel` | objeto o `null` | `null` | `{provider, id}` del modelo para el modo `summary` |
| `copySpeech` | booleano | `false` | Leer las selecciones copiadas (macOS) |
| `macVoice` | cadena o `null` | `null` | Nombre de la voz del sistema; `null` elige la mejor voz en español instalada |
| `macFallback` | booleano | `true` | Hablar con la voz del sistema cuando la voz elegida falta o falla |
| `qwenIdleMinutes` | entero o `null` | `10` | Minutos que el servicio Qwen compartido sigue cargado tras cerrarse la última sesión (de 1 a 60); `null` significa no descargarlo nunca |
| `shortcuts` | objeto | ver abajo | Teclas para `speakLast`, `stop`, `toggle`, `cycleVoice` y `toggleCopy` |
| `dotOffer` | `"declined"` o `null` | `null` | Recuerda que rechazaste la oferta de Gentle Dot |
| `setupOffer` | `"declined"` o `null` | `null` | Recuerda que rechazaste la instalación del primer arranque |
| `dotSpeech` | booleano | `false` | Indicador antiguo de Dot; ahora se ignora (Dot usa su propio archivo de ajustes) |

`shortcuts` por defecto:

```json
{
  "speakLast": "ctrl+alt+v",
  "stop": "ctrl+alt+.",
  "toggle": "ctrl+alt+m",
  "cycleVoice": "ctrl+alt+n",
  "toggleCopy": "ctrl+alt+c"
}
```

### Velocidad

`/speak` → **Speed** acepta un número de 0.5 a 2. En las voces Qwen, una velocidad distinta de 1 necesita `ffmpeg`. Sin él, las voces Qwen suenan a su velocidad nativa y te lo dicen una vez.

### Tiempo de espera de Qwen

`/speak` → **Mantener Qwen tras cerrar la última sesión** ofrece `1 min`, `2 min`, `5 min`, `10 min`, `30 min`, `60 min` y `Nunca`. El cambio se aplica al momento, sin reiniciar. `/speak` → **Detener servicio Qwen** detiene el servicio ahora; la siguiente frase con Qwen lo vuelve a iniciar. Consulta [El servicio Qwen compartido](arquitectura.md#el-servicio-qwen-compartido).

### Voz del sistema

`/speak` → **Voz del sistema** fija `macVoice`: `Auto` (guardado como `null`) o una de las voces en español instaladas. Consulta [Voz del sistema](voces.md#voz-del-sistema).

## Ejemplo

Un archivo completo, tal como lo escribe `/speak` (en una sola línea):

```json
{"schema":"gentle-speak.settings/v1","enabled":true,"mode":"questions-and-results","voice":"es_MX","speed":1,"summaryModel":null,"copySpeech":false,"macVoice":null,"macFallback":true,"dotSpeech":false,"dotOffer":null,"setupOffer":null,"qwenIdleMinutes":10,"shortcuts":{"speakLast":"ctrl+alt+v","stop":"ctrl+alt+.","toggle":"ctrl+alt+m","cycleVoice":"ctrl+alt+n","toggleCopy":"ctrl+alt+c"}}
```
