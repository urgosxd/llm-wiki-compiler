# docker-hub-multiarch — publicar la imagen en Docker Hub con soporte ARM

## Goal

Publicar el contenedor del producto en Docker Hub como una única imagen
multi-arquitectura (`linux/amd64` + `linux/arm64`) bajo `urgosxd/llmwiki:latest`,
partiendo del `Dockerfile` que ya existe.

## Decisiones ratificadas por el humano

1. **Repositorio**: `docker.io/urgosxd/llmwiki` → corregido a **`docker.io/urgosxd7/llmwiki`**.
   Motivo: la credencial configurada autentica como `urgosxd7` (verificado contra la
   API de Hub: 6 repos propios). El namespace `urgosxd` existe pero es una cuenta
   distinta; el push falló con `insufficient_scope`. Docker Hub no crea
   repositorios en namespaces ajenos.
2. **Tags**: solo `latest`. Sin tag por versión; el pin queda a cargo del consumidor
   vía digest.
3. **Alcance de la sesión**: build multi-arch **más push** a Docker Hub.
4. **Arquitecturas**: `linux/amd64` y `linux/arm64`. Se descarta `arm/v7`.

## Estado encontrado (explorado antes de escribir)

### El Dockerfile ya es multi-arch correcto

No requiere cambios de estructura. La razón es cómo está partido:

- `npm ci` corre **dentro del stage `build`**, en un contenedor de la plataforma
  objetivo. Bajo buildx, cada plataforma ejecuta sus propios `RUN`, así que npm
  resuelve los `optionalDependencies` nativos de esa arquitectura.
- Los módulos nativos que importan son `@napi-rs/canvas` (vía `pdf-parse`) y
  `esbuild`. Ambos están en el lockfile con variantes por arquitectura:
  `@napi-rs/canvas-linux-arm64-gnu` y `@esbuild/linux-arm64` existen.
- `node:24-slim` publica `linux/arm64`. Sin problema de base.

Verificado sobre la imagen amd64 construida: contiene exactamente
`skia.linux-x64-gnu.node` y `skia.linux-x64-musl.node`. Es decir, los binarios
nativos se resuelven por plataforma, no se hornean desde el host.

### El defecto real: `.dockerignore` no cubre lo que `.gitignore` sí

`.dockerignore` excluye `node_modules`, `dist`, `docs`, `test`, `.env`, etc., pero
**omite** varias entradas que `.gitignore` sí tiene. Medido con un walk que aplica
los patrones de `.dockerignore`:

- contexto real: **156.1 MB**
- de esos, **146.5 MB son `.codegraph/`** (índice local de análisis)
- **3.4 MB son `.fallow/`** (caché del analizador de salud)

Ambos son cachés locales regenerables. Se envían al daemon en cada build y no los
usa nadie dentro de la imagen. Entradas de `.gitignore` ausentes en
`.dockerignore`: `node_modules/`, `dist/`, `.llmwiki/`, `.llm-wiki/`, `/wiki/`,
`/sources/`, `/log.md`, `*.tmp`, `.DS_Store`, `localdocs/`, `.fallow/`,
`.worktrees/`, `.sisyphus/`, `.claude/`, `*-wiki/`, `docs/superpowers/`, `.atl/`,
`/uploads/`, `.codegraph/`.

(Las primeras ya están cubiertas por otros patrones de `.dockerignore`; las que
importan por tamaño son `.codegraph/`, `.fallow/` y `.atl/`.)

### QEMU para arm64 no estaba registrado

`/proc/sys/fs/binfmt_misc/` tenía sólo `python3.12` y `status`. Sin emulación, un
`RUN` de arm64 falla con `exec format error`. Se resuelve con
`docker run --privileged tonistiigi/binfmt --install arm64`, que no necesita sudo
porque lo ejecuta el daemon.

## Tasks

- [x] Cerrar la brecha `.gitignore` → `.dockerignore` para los cachés locales
- [x] Registrar emulación QEMU para `linux/arm64`
- [x] Build `linux/amd64,linux/arm64` y push de `urgosxd7/llmwiki:latest`
- [x] Verificar el manifest list y smoke test de ambas arquitecturas

## Evidence

Manifest list publicado:

```
docker.io/urgosxd7/llmwiki:latest
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:e39c1563e50f23e8af2cb6073b447d8e1352083c516eef9f70953d4683d0efae
  linux/amd64  sha256:a47bad7d5d870261495f537d1582a2df36e6f32d4046180e8e9c1ec623b4fc06
  linux/arm64  sha256:a87bb10913c118a4840b665c7244ce0c54f17176b77ad60c1c32bd7153c0be11
```

Smoke test, mismo tag resuelto por plataforma:

| chequeo | linux/amd64 | linux/arm64 |
| --- | --- | --- |
| `process.arch` | `x64` | `arm64` |
| `node dist/cli.js --version` | `1.4.0-dev.20260919` | `1.4.0-dev.20260919` |
| binario nativo `skia` | `linux-x64-{gnu,musl}` | `linux-arm64-{gnu,musl}` |
| MCP sobre stdio | — | `initialize` responde `serverInfo: llmwiki/1.4.0-dev.20260919` |
| modo `LLMWIKI_MODE=host` | — | `Host ready at http://172.17.0.3:4173` |

El modo host es el que valida `entry.sh`: bindea la dirección IPv4 del contenedor,
no el wildcard, porque el gate de origen del viewer rechaza `0.0.0.0`.

## Notas para después

- `README.md` no menciona Docker en absoluto. La imagen publicada no está
documentada en ningún lado del repo.
- `docker-compose.yml` construye localmente (`build:`), no consume la imagen
publicada. Si el compose tiene que usar el tag de Hub, hay un cambio pendiente ahí.
- Sin workflow de CI que republique en releases; el push fue manual desde esta
máquina.
