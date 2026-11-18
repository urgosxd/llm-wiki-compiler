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

### Publicación vigente — 2026-11-17, sobre HEAD `d2ddb5f5` (sin smoke tests, por pedido)

Repetida a pedido del humano. Alcance pedido explícitamente: **build multi-arch + push, sin smoke
tests**. La verificación se limita al manifest list leído de vuelta del registry; no se ejecutó
ningún contenedor de ninguna de las dos arquitecturas, así que esta corrida **no** re-verifica que la
imagen arranque ni que el binario nativo `skia` resuelva por plataforma. Esa evidencia sigue siendo
la de las dos corridas anteriores, y está fechada.

Entorno confirmado antes de construir: builder `multibuilder` (driver `docker-container`) reporta
`linux/amd64`, `linux/arm64` y `linux/386`; `qemu-aarch64` registrado en
`/proc/sys/fs/binfmt_misc/`; `docker info` autentica como `urgosxd7`.

Diff del árbol respecto de la publicación anterior: **sólo** `odd/tasks/docker-hub-multiarch.md`
(commit `d2ddb5f5`, docs). `.dockerignore` excluye `odd/` y `*.md`, así que ese cambio no entra al
contexto de build: el contenido de la imagen es el mismo que el de `ed226a2e`.

```
docker buildx build --builder multibuilder \
  --platform linux/amd64,linux/arm64 \
  --tag docker.io/urgosxd7/llmwiki:latest --push .
```

Resultado: exit `0` en **7 m 32 s**, con `pushing layers 213.0s` y `pushing manifest 4.3s`. Los
stages `linux/arm64` (`pnpm install --frozen-lockfile`, `pnpm run build`, el `runtime` completo) se
ejecutaron bajo emulación, no se copiaron desde el host.

```
docker.io/urgosxd7/llmwiki:latest
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:37863d0dc29fc90e86d5ef64f3af829491a296c48d5da103467eafdd77ae85c6
  linux/amd64   sha256:7650e3395642865aad1381f189102872a3800d99741c21eba8b184ba65278915
  linux/arm64   sha256:e7b8a8c910b160270a8da15b11629bb297d70db7765837f6118b88298be63730
  unknown/unknown  sha256:5cdaba2e81be2a6c0c3fa23b57269d07813aff00129b68c5359aa0084ee307ee  (attestation amd64)
  unknown/unknown  sha256:bb25fed06e8b44808cc8777fd50d160ffde9dbb41abadb340f6e54786f004c92  (attestation arm64)
```

Leído con `docker buildx imagetools inspect docker.io/urgosxd7/llmwiki:latest`, que resuelve contra
`registry-1.docker.io` en vez de contra el cache local. Las dos entradas de plataforma son
`application/vnd.oci.image.manifest.v1+json` reales, con sus digests de config y attestation
provenance. Consumo por digest: `urgosxd7/llmwiki@sha256:37863d0d…`.

### Publicación anterior — 2026-11-17, sobre HEAD `ed226a2e`

Repetida a pedido del humano sobre el árbol limpio de `main` (`ed226a2e`, "test(package-selection):
freeze the foundation artifact test as an orphan"), con la emulación `qemu-aarch64` ya registrada en
`/proc/sys/fs/binfmt_misc/`. Comando, tal cual, con el builder `multibuilder` (driver
`docker-container`, soporta `linux/arm64`):

```
docker buildx build --builder multibuilder \
  --platform linux/amd64,linux/arm64 \
  --tag docker.io/urgosxd7/llmwiki:latest --push .
```

Resultado: exit `0` en **4 m 29 s**, con `pushing layers 17.3s` y `pushing manifest 4.4s`.
Manifest list publicado, leído de vuelta del registry (`registry-1.docker.io`) y coincidente con
`docker manifest inspect`:

```
docker.io/urgosxd7/llmwiki:latest
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:0c9d4905559013e4358c79cf75d8eca9fd0a80653226ccf6b03eacfbaf3dcef7
  linux/amd64   sha256:4175b98f3347b13df4fe44865aaec4a156673f9dc2d64970d54df06a2fa878e2
  linux/arm64   sha256:b96f6603ea135d6d8f0b301cc33bcd60fe9290b7c63e6a89d08165615b51e3ab
  unknown/unknown  sha256:794fd415b3e49c8aa22a3c375022368a58ce42865b91f02e385aad75557b226a  (attestation amd64)
  unknown/unknown  sha256:af495b6f79fb094dccc764498ac0dd8936c231998238d72193265b5e262cb55c  (attestation arm64)
```

Smoke test contra el tag publicado (las dos plataformas resueltas desde el mismo `latest`):

| chequeo | linux/amd64 | linux/arm64 |
| --- | --- | --- |
| `process.arch` | `x64` | `arm64` |
| `require('/app/package.json').version` | `1.4.0-dev.20260919` | `1.4.0-dev.20260919` |
| binario nativo `skia` | `skia.linux-x64-gnu.node` | `skia.linux-arm64-gnu.node` |
| MCP `initialize` sobre stdio | `serverInfo: llmwiki/1.4.0-dev.20260919` | `serverInfo: llmwiki/1.4.0-dev.20260919` |

Dos observaciones de esta corrida, anotadas para que nadie las lea como fallas:

- `node /app/dist/api.js --version` responde `unknown option: --version`. No es una regresión: ese
  flag no existe en el launcher `api.js` (sus comandos son `host` y `serve`), así que la versión se
  verifica contra `/app/package.json`, que es lo que la tabla de arriba registra.
- El install de `cpu-features`/`ssh2` deja sus bindings nativos opcionales sin compilar
  (`Error: Unable to detect compiler type`, `Could not find any Python installation to use`). Son
  `optionalDependencies` con fallback en JS y no rompen el build: `pnpm install` termina `0` y la
  imagen arranca en ambas arquitecturas.

### Publicación anterior — superada por la de arriba

Manifest list publicado entonces:

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
