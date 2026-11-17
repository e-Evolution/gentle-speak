---
title: Contribuir
parent: Español
nav_order: 11
lang: es
translation: contributing.md
---

# Contribuir

Los informes de errores, los informes de plataformas y las pull requests son bienvenidos. Los informes desde máquinas reales con Linux y Windows son especialmente útiles: esas plataformas se prueban con simulaciones en la CI, pero todavía no se han comprobado en vivo.

- **Cómo contribuir:** lee [CONTRIBUTING.md](https://github.com/e-Evolution/gentle-speak/blob/main/CONTRIBUTING.md) (en inglés). Explica cómo preparar el entorno de desarrollo, las pruebas y su protección del directorio personal real, las convenciones de código y las pull requests.
- **Errores e ideas:** abre una [incidencia](https://github.com/e-Evolution/gentle-speak/issues). Incluye la salida de `/speak doctor` y tu plataforma. Para cualquier cosa mayor que un arreglo pequeño, abre primero una incidencia para que acordemos el enfoque.
- **Historial:** consulta [CHANGELOG.md](https://github.com/e-Evolution/gentle-speak/blob/main/CHANGELOG.md) (en inglés).

## Desarrollo en pocas palabras

Necesitas Node.js 24 o posterior.

```bash
git clone https://github.com/e-Evolution/gentle-speak.git
cd gentle-speak
npm ci
npm test
```

Para probar tu copia local dentro de Gentle Shell sin instalarla:

```bash
gentle-shell -- -e ./extensions/gentle-speak.ts
```

## Reportar una vulnerabilidad

No abras una incidencia pública para un problema de seguridad. Sigue [SECURITY.md](https://github.com/e-Evolution/gentle-speak/blob/main/SECURITY.md) (en inglés): abre la pestaña **Security** (seguridad) del repositorio y elige **Report a vulnerability** (reportar una vulnerabilidad). Consulta también [Privacidad y seguridad](privacidad.md#reportar-una-vulnerabilidad).

Al contribuir, aceptas que tu contribución se licencie bajo la licencia MIT de este proyecto.
