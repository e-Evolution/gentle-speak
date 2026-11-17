---
title: Uso
parent: Español
nav_order: 2
lang: es
translation: usage.md
---

# Uso
{: .no_toc }

1. TOC
{:toc}

---

## Encender la voz

La lectura automática está **apagada** hasta que la enciendes. Usa una de estas opciones:

- la tecla de activación, `ctrl+alt+m` por defecto; o
- `/speak` → **Toggle auto-speak** (activar o desactivar la lectura automática).

La misma acción la vuelve a apagar. Al apagarla también se descarta lo que esperaba a que tu panel recibiera el foco.

## Qué se lee en voz alta

Cuando termina una ejecución del agente, gentle-speak decide si lee el texto final del asistente.

Nunca lee:

- bloques de código, diffs ni salida de herramientas;
- turnos que llaman a herramientas.

Las sesiones RPC, print, JSON y las sesiones hijas delegadas nunca hablan. La única excepción es la sesión raíz de Gentle Dot; consulta [Gentle Dot](gentle-dot.md). Recargar o cerrar detiene el audio y descarta la voz pendiente.

## Modos

Elige un modo con `/speak` → **Mode: all**, **Mode: questions-and-results** o **Mode: summary** (modo: todo, preguntas y resultados, o resumen).

| Modo | Qué se lee |
|------|------------|
| `questions-and-results` (por defecto) | Las preguntas finales y los resultados útiles. Se omite la simple narración del tipo "Estoy revisando…" |
| `all` | Cada respuesta final en prosa |
| `summary` | Una frase corta en español escrita por un modelo que tú eliges (`/speak` → **Summary model**, el modelo del resumen). Si no hay modelo seleccionado, no se lee nada |

En el modo `summary`, el texto final depurado (nunca la salida de herramientas) se envía al modelo que elijas. Ese modelo puede ser un proveedor en la nube, con sus costes habituales. **Summary model** solo enumera los modelos que tienen credenciales configuradas, y además **None** (ninguno).

## Atajos de teclado

| Tecla por defecto | Acción | Qué hace |
|-------------------|--------|----------|
| `ctrl+alt+v` | `speakLast` | Lee el último mensaje del asistente |
| `ctrl+alt+.` | `stop` | Detiene la reproducción |
| `ctrl+alt+m` | `toggle` | Enciende o apaga la lectura automática |
| `ctrl+alt+n` | `cycleVoice` | Cambia a la siguiente voz disponible |
| `ctrl+alt+c` | `toggleCopy` | Enciende o apaga la lectura de lo copiado |

La tecla de parada solo detiene la voz de tu propia sesión, no la de otra terminal.

### Cambiar una tecla

1. Abre `/speak` → **Key: speakLast**, **Key: stop**, **Key: toggle**, **Key: cycleVoice** o **Key: toggleCopy** (tecla de cada acción).
2. Escribe la nueva tecla, por ejemplo `ctrl+alt+j`.
3. Reinicia Gentle Shell para aplicarla, por ejemplo con `gentle-shell -r` para reanudar tu sesión. La confirmación dice «Restart Gentle Shell (for example gentle-shell -r) to apply shortcut changes» (reinicia Gentle Shell para aplicar los cambios de atajos). No uses `/reload`: puede hacer que Gentle Shell 4.7.0 se cierre de golpe.

Una tecla es uno o varios de `ctrl+`, `alt+` y `shift+`, seguidos de una sola letra, un dígito o uno de `.` `,` `;` `/`. Se rechazan los duplicados, y también las teclas que Pi y Gentle Shell reservan (`ctrl+k`, `ctrl+p`, `alt+k`, `alt+a`). Una tecla no válida no se guarda: verás «Invalid speech settings; nothing was saved.» (ajustes de voz no válidos; no se guardó nada).

## La herramienta `speak`

El modelo también puede hablar a propósito mediante la herramienta **`speak`**, incluso con la lectura automática apagada. Recibe un argumento `text`:

- de hasta 4000 caracteres;
- no vacío y sin caracteres de control (por tanto, sin saltos de línea).

Solo habla en una sesión padre interactiva (o en la sesión raíz de Gentle Dot). Cuando tu panel no tiene el foco, la herramienta responde «Speech deferred until this pane has focus.» (voz aplazada hasta que este panel tenga el foco) y el texto se lee más tarde; consulta [Foco](#foco-con-varios-paneles).

## Leer el texto copiado

La lectura de lo copiado lee en voz alta el texto que seleccionas y copias en **este** Gentle Shell.

- Está **apagada** por defecto. Enciéndela con `/speak` → **Toggle speak copied selection** (activar o desactivar la lectura de la selección copiada), o con `ctrl+alt+c`.
- Funciona **solo en macOS**, en la TUI a pantalla completa.
- Depende de que la copia sea tuya. La aplicación de terminal debe estar en primer plano, y el texto copiado debe ser la selección visible.
- Se omiten las copias ocultas, transitorias y las de gestores de contraseñas.
- El texto del portapapeles nunca se guarda ni se registra.

## La fila SPEAK

En la terminal interactiva aparece una fila `SPEAK` bajo INTEGRATIONS, por ejemplo:

```text
SPEAK ● on · modo todo · Propia · Ana · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c
```

Muestra, en este orden:

- el estado (`● on` u `○ off`);
- el modo (`modo todo`, `modo preguntas y resultados` o `modo resumen`; `modo resumen sin modelo` cuando no hay modelo de resumen);
- la voz;
- tus teclas de activación y de cambio de voz;
- el estado de la lectura de lo copiado y su tecla.

Es una fila de estado, no un control en el que se pueda hacer clic. Gentle Shell no tiene una API pública de clics para ella.

## Foco con varios paneles

La lectura automática y la herramienta `speak` suenan de inmediato cuando tu panel tiene el foco. Si no, solo se guarda el resultado **más reciente** de esa sesión, y se lee cuando pones el foco en el panel. El resultado guardado se descarta cuando apagas la voz, pulsas la tecla de parada, recargas o cierras.

gentle-speak sabe qué tiene el foco gracias a estas fuentes, en este orden:

1. los propios avisos de foco de la terminal (`ESC[I` / `ESC[O` de pi-tui; dentro de tmux, activa `focus-events on`);
2. Herdr (`HERDR_ENV=1`, luego `herdr pane get $HERDR_PANE_ID`);
3. en macOS, la aplicación en primer plano, que debe ser tu terminal;
4. la escritura: cuando la terminal no envía ningún evento de foco, haber escrito en los últimos 60 segundos cuenta como foco.

Cuando no se sabe qué tiene el foco, el turno se lee en orden y empieza con el nombre del proyecto, por ejemplo `my-project: …`.

`HERDR_BIN_PATH` solo se respeta si es una ruta absoluta a un ejecutable llamado `herdr`.

{: .nota }
Shift+F3, Alt+Shift+F3 y Ctrl+F3 envían `ESC[1;<modifier>R`, que es, byte a byte, la respuesta de la terminal con la posición del cursor en la fila 1. Por eso esas tres teclas, por sí solas, no cuentan como escritura. Cualquier otra tecla con modificador sí cuenta, y las demás fuentes de foco no se ven afectadas.

## Una voz a la vez

Cada reproducción toma un cerrojo entre procesos en `~/.gentle-speak/`. Las sesiones de distintas terminales, los paneles de Herdr y Gentle Dot se turnan y nunca hablan a la vez. Si el proceso que tenía el cerrojo murió, el cerrojo se recupera.
