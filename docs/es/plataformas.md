---
title: Plataformas
parent: Español
nav_order: 7
lang: es
translation: platforms.md
---

# Plataformas

## Qué está verificado

- **La CI** ejecuta todo el conjunto de pruebas en macOS, Linux y Windows, con Node.js 24. Las pruebas usan simulaciones (fakes) de los procesos, los dispositivos de audio, el portapapeles y la red.
- **Las pruebas en vivo** del audio, el foco y la voz del sistema solo se han hecho en **macOS en Apple Silicon**.
- **Linux y Windows no están verificados en vivo.** Sus opciones de voz del sistema (`spd-say`, `espeak-ng`, SAPI) salen de la documentación de esas herramientas. macOS en Intel no está probado.
- **Las voces Qwen son solo para Apple Silicon.**

Los informes desde máquinas reales con Linux y Windows son bienvenidos; consulta [Contribuir](contribuir.md).

## Tabla de funciones

| Función | macOS arm64 | macOS Intel | Linux | Windows |
|---------|:-----------:|:-----------:|:-----:|:-------:|
| Piper (runtime nativo) | ✓ | existe el destino del runtime | destinos x64 y arm64, solo con simulaciones | destino x64, solo con simulaciones |
| Qwen3-TTS | ✓ | ✗ (solo Apple Silicon) | ✗ | ✗ |
| Voz del sistema | ✓ (`say`) | ✓ (`say`) | solo con simulaciones | solo con simulaciones |
| Lectura de lo copiado | ✓ | ✓ | ✗ | ✗ |
| Eventos de foco de la terminal | ✓ | ✓ | ✓ si la terminal los envía | ✓ si la terminal los envía |
| Foco de Herdr | ✓ (donde funcione Herdr) | igual | igual | igual |
| Gentle Dot | ✓ | sin probar | sin probar | sin probar |

✓ significa que funciona en esa plataforma, y solo macOS arm64 se ha ejecutado en vivo. "Solo con simulaciones" significa que el código existe y se prueba con simulaciones en la CI, pero no se ha ejecutado en una máquina real.

## Notas por plataforma

- **Destinos del runtime nativo:** `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` y `win32-x64`. En otras plataformas no se puede instalar el runtime.
- **Linux:** los binarios nativos precompilados necesitan glibc 2.34 o posterior. Es un requisito de origen; gentle-speak no lo comprueba. La voz del sistema necesita `sudo apt install speech-dispatcher espeak-ng` (o el gestor de paquetes de tu distribución).
- **`spd-say` en Linux:** detener la voz (o un tiempo de espera agotado) ejecuta `spd-say -C`, que cancela todo lo que speech-dispatcher tenga en cola, incluida la voz de otras aplicaciones. No puede cancelar solo la de gentle-speak. No verificado en vivo.
- **Windows** necesita `powershell.exe` en el `PATH` para la voz del sistema; sin él, la voz del sistema se indica como no disponible. La enumeración de voces tiene un límite de 8 segundos, y una enumeración que no responde cuenta como ninguna voz.
- **La lectura de lo copiado** es la única función que necesita macOS, y además necesita la TUI a pantalla completa. En Linux y Windows el resto de gentle-speak funciona; la lectura de lo copiado se indica como no disponible.
