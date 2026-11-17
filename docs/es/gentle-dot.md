---
title: Gentle Dot
parent: Español
nav_order: 5
lang: es
translation: gentle-dot.md
---

# Gentle Dot
{: .no_toc }

gentle-speak puede hablar dentro del motor de Gentle Dot, sin modificar Dot.

1. TOC
{:toc}

---

## La oferta

En el primer arranque en la terminal, si Gentle Dot está instalado y su `settings.json` no incluye gentle-speak, se te pregunta una vez:

> «Encontré Gentle Dot. ¿Querés que también hable ahí?»

- **Yes** (sí) lo conecta (consulta más abajo).
- **No** se recuerda (`dotOffer: "declined"` en los ajustes de la terminal), y no se te vuelve a preguntar.

gentle-speak busca el directorio del motor de Dot en `GENTLE_DOT_AGENT_HOME`, por defecto `~/.gentle-dot/agent`.

## Conectar y desconectar

Abre `/speak` → **Gentle Dot**. La primera línea muestra el estado, por ejemplo `Gentle Dot: conectado · habla: sí · voz es_MX · modo questions-and-results`. Las opciones son:

| Opción | Qué hace |
|--------|----------|
| **Conectar Gentle Dot** | Hace una copia de seguridad del `settings.json` de Dot, le añade el paquete gentle-speak y enciende la voz en los propios ajustes de voz de Dot |
| **Desconectar Gentle Dot** | Hace una copia de seguridad del `settings.json` de Dot, quita solo la entrada de gentle-speak y pone el `enabled` de Dot en `false`. El archivo de ajustes de voz de Dot se conserva |
| **Hablar en Dot** | Enciende o apaga la voz en Dot |
| **Voz de Dot** | Elige la voz de Dot, de la misma lista que la terminal |
| **Modo de Dot** | Elige el modo de Dot: `all`, `questions-and-results` o `summary` |
| **Volver** | Vuelve atrás |

Detalles:

- La copia de seguridad es `settings.json.gentle-speak-backup-<timestamp>`, junto al original. Nunca se sobrescribe una copia anterior.
- En la primera conexión, los ajustes de voz de Dot se inicializan a partir de los de la terminal, con `enabled: true` y `copySpeech: false`.
- Nunca se escribe en un `settings.json` de Dot mal formado; en su lugar recibes un aviso.
- **Reinicia Dot** después de conectar o desconectar.

## Silenciar la voz propia de Dot

Dot tiene sus propias respuestas habladas. Desactívalas con el botón **«Mute spoken replies»** (silenciar las respuestas habladas) de Dot, el icono del altavoz en la cabecera del chat. Si no, oirás cada respuesta dos veces. Después de conectar, gentle-speak te lo recuerda: «Gentle Dot conectado: silenciá la voz propia de Dot y reinicialo.»

## Sus propios ajustes

Dot tiene su propio archivo de ajustes: `<Dot HOME>/.gentle-speak/speak-settings.json`.

- El HOME de Dot es `dirname(<Dot agent home>)/home`, así que por defecto es `~/.gentle-dot/home`. `GENTLE_DOT_HOME` lo sustituye.
- Dot solo habla si su propio `enabled` es `true`. Los ajustes de la terminal no encienden ni apagan Dot.
- El archivo tiene las mismas claves que el de la terminal; consulta [Configuración](configuracion.md#ajustes).

Compartido con la terminal, para que nada se descargue dos veces:

- el runtime nativo y los modelos Piper;
- tus propias voces;
- la caché de Hugging Face;
- el servicio Qwen compartido;
- el cerrojo de voz, para que Dot nunca hable a la vez que la terminal.

## Qué habla en Dot

Solo habla la sesión RPC raíz de Dot. Usa la misma voz, el mismo modo, el mismo filtro, la misma síntesis especulativa y el mismo cerrojo de voz que la terminal, con dos diferencias:

- Toma su turno de inmediato: no hay aplazamiento por foco.
- Cada texto empieza con el prefijo `Dot: `, para que sepas qué aplicación está hablando.

Dot no tiene fila SPEAK, ni atajos, ni lectura de lo copiado.

## Orígenes de paquete aceptados

gentle-speak solo escribe o reconoce estas entradas en el `settings.json` de Dot, y nada más:

- un directorio local absoluto cuyo `package.json` tenga el nombre `@e-evolution/gentle-speak` (o el antiguo `gentle-speak`);
- `npm:@e-evolution/gentle-speak`, opcionalmente con `@<version>` (o el antiguo `npm:gentle-speak`);
- un origen git de un repositorio llamado `gentle-speak`: `git:<host>/<owner>/gentle-speak[.git][@ref]` o `https://<host>/<owner>/gentle-speak[.git][@ref]`.

Se rechazan las credenciales, los parámetros de consulta, los fragmentos, las formas ssh y file, y cualquier otro nombre, y no se escribe nada.

## Comprobar la conexión

`/speak doctor` informa de la conexión con Dot: ✓ conectado, – no instalado o no conectado, o ✗ cuando el `settings.json` de Dot está mal formado. Consulta [Solución de problemas](problemas.md).
