---
title: Español
nav_order: 14
has_children: true
has_toc: false
lang: es
translation: index.md
description: "gentle-speak lee en voz alta las preguntas y los resultados de Gentle Shell, con voces locales."
---

<img class="home-logo" src="{{ '/assets/images/logo.svg' | relative_url }}" alt="Logo de gentle-speak: un cursor que se convierte en una onda de sonido">

# gentle-speak
{: .fs-9 }

Texto a voz local y opcional para Gentle Shell (Pi). Lee en voz alta las preguntas del agente y sus resultados útiles, para que no tengas que leer cada respuesta después de cada tarea.
{: .fs-6 .fw-300 }

[![Creado con gentle-ai](https://img.shields.io/badge/built%20with-gentle--ai-f43888)](https://github.com/Gentleman-Programming/gentle-ai)

[Instálalo](instalacion.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[Ver en GitHub](https://github.com/e-Evolution/gentle-speak){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## Qué hace

- **Habla cuando termina una ejecución del agente.** Lee las preguntas finales y los resultados útiles. Nunca lee bloques de código, diffs, salida de herramientas ni turnos que llaman a herramientas.
- **Funciona en tu máquina.** La síntesis, las voces y el servicio Qwen compartido son locales. No se sube ningún audio ni ninguna voz.
- **Empieza en silencio.** La lectura automática está apagada hasta que la enciendes, y nada se descarga hasta que lo confirmas.
- **Usa la voz que elijas:**
  - Piper, pequeña y rápida;
  - Qwen3-TTS, clonada de tu propia voz o de una voz que diseñas a partir de una descripción en texto (Apple Silicon);
  - la voz del sistema.
- **También funciona en Gentle Dot.** Puede hablar dentro del motor de Gentle Dot, sin modificar Dot.

## Para quién es

gentle-speak es para quienes usan Gentle Shell en ejecuciones largas del agente y prefieren escuchar a seguir leyendo. Puedes apartar la vista mientras el agente trabaja y aun así oír cuando te pregunta algo o termina.

## Resumen rápido

1. Instala el paquete y reinicia Gentle Shell (por ejemplo, `gentle-shell -r` para reanudar tu sesión).
2. Acepta la única confirmación de instalación, «Instalar todo». Descarga el runtime de audio y una voz Piper, y además las partes de Qwen en Apple Silicon.
3. Ejecuta `/speak doctor` para comprobar que todo funciona.
4. Enciende la voz con `ctrl+alt+m`, o con `/speak` → **Toggle auto-speak** (activar o desactivar la lectura automática).

## Qué leer después

| Página | Qué encontrarás |
|--------|-----------------|
| [Instalación](instalacion.md) | Instalar desde npm, GitHub o una copia local; la instalación del primer arranque; requisitos |
| [Uso](uso.md) | Encender la voz, modos, teclas, la herramienta `speak`, lectura de lo copiado, foco |
| [Voces](voces.md) | Los motores, y cómo crear o importar tu propia voz |
| [Configuración](configuracion.md) | Cada ajuste, su valor por defecto y el archivo de ajustes |
| [Gentle Dot](gentle-dot.md) | Hablar dentro de Gentle Dot |
| [Arquitectura](arquitectura.md) | Cómo encajan las partes, y cómo se usan los modelos Qwen |
| [Plataformas](plataformas.md) | Qué funciona en cada plataforma y qué está verificado |
| [Hardware, tokens y velocidad](requisitos.md) | Qué necesita cada voz, el consumo estimado de tokens y qué tan rápido habla |
| [Solución de problemas](problemas.md) | `/speak doctor` y problemas frecuentes |
| [Privacidad y seguridad](privacidad.md) | Qué se queda en local, qué se descarga y desde dónde |
| [Licencias](licencias.md) | La licencia MIT y los componentes de terceros |
| [Contribuir](contribuir.md) | Cómo ayudar y cómo reportar una vulnerabilidad |

gentle-speak es una extensión comunitaria para Gentle Shell. No está afiliada a Gentleman Programming.
