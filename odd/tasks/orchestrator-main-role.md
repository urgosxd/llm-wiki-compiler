# orchestrator-main — rol de coordinación sin worktree

## Goal

Agregar un rol `orchestrator-main` al contrato de coordinación que corre en el
checkout primario (no se le crea worktree) y que puede comunicarse con
`orchestrator-a`, `orchestrator-b` y `orchestrator-c` sin que ninguno de los dos
lados rechace el mensaje.

## Decisiones ratificadas por el humano

1. **Superficie de escritura: solo lectura.** `ownedPaths` se reduce a
   `.orchestration-main-readonly/**`, un prefijo que ningún archivo real usa. El rol
   no puede escribir producto. Puede emitir `work_request`, `contract_proposal`,
   `contract_decision`, `blocked` y `done`; un `work_result` suyo con archivos de
   producto es `files-changed-out-of-scope` y se rechaza, que es exactamente la
   respuesta correcta para un rol que no implementa.
2. **`worktree: ""` significa "corre en el checkout primario".** No se agrega un
   campo nuevo al schema; el string vacío resuelve con `path.resolve(root, "")` al
   root del repositorio, que es el checkout primario que git lista primero.

## Why the current validator cannot express this

- `src/scope.schema.json` declara `worktree` como requerido y no vacío en la
  práctica (un `""` resolvía a un path que no es un worktree registrado).
- `src/worktree.ts` aplica tres checks: el worktree existe en
  `git worktree list --porcelain`, dos roles no comparten worktree, y ningún rol
  usa el checkout primario. El tercero es el que rechaza el rol nuevo.
- `src/enforce.ts#bindSession` devuelve `bound: false` si el rol no está declarado
  o si el precondicionado de worktrees falla, y el hook `orchestrator-coord` falla
  **abierto** con un warning: el rol queda sin scope y, peor, un contrato entero
  inválido desactiva la verificación de todos los roles vivos.

## Design

### Validador (`~/.agents/orchestration`)

- `scope.ts`: `RoleScopeSchema.worktree` sigue siendo `z.string()`; el vacío es
  válido y significa primario. Se documenta en el JSDoc del campo.
- `worktree.ts`:
  - `resolveRoleWorktrees` resuelve `""` al root del repositorio.
  - El check del checkout primario deja de ser incondicional: **exactamente un rol
    puede resolver al primario**, y solo si su `worktree` es `""`. Cualquier otro
    rol que resuelva al primario con un path relativo (`..`, `.`) sigue rechazado.
  - Dos roles con `worktree: ""` se reportan como "primary checkout claimed by
    more than one role".
  - Se conserva el orden: unknown → duplicate → primary.
- `enforce.ts`: `roleWorktree` de un rol primario es el `repoRoot`, así que los
  targets relativos se resuelven contra el checkout primario sin casos especiales.
- `coordination-check.ts`: la línea de plan imprime `<primary>` para el rol sin
  worktree.

### Launcher (`bin/orchestrate.sh`)

- `ensure_worktrees` saltea el rol con `worktree: ""` (no se crea nada en disco).
- `launch_role` usa el root del repositorio como cwd de ese rol.
- `print_plan` muestra `cwd=<primary checkout>` y `[primary]`.
- `assert_committed_contract_declares_role` no aplica: no hay worktree que cortar.

### Contrato del repo (`contract-cordination.json`)

```json
"orchestrator-main": {
  "module": "coordination-and-integration",
  "worktree": "",
  "ownedPaths": [".orchestration-main-readonly/**"],
  "forbiddenPaths": [".worktrees/**", "packages/llmwiki-kg/**", "src/**", "test/**"]
}
```

`forbiddenPaths` incluye todo lo que el rol no debe tocar, pero deja los paths
compartidos (`package.json`, `docs/**`, etc.) con su razón honesta:
`shared-read-only`, no `forbidden`.

## Comunicación con los demás roles

Ningún receptor rechaza por el rol emisor: `decideMessage` (bound) y
`decideUnboundMessage` (unbound) validan forma del envelope y veracidad de las
citas. Con el rol declarado, `orchestrator-main` queda **bound** y gana el chequeo
de scope, que es el que lo mantiene honesto. `from-equals-to` sigue evitando que se
escriba a sí mismo.

## Tasks

- [x] 1. Registrar la feature (este documento + espejo en Engram).
- [x] 2. Validador: `worktree: ""` = primario, exactamente uno.
- [x] 3. Tests nuevos del validador (scope/worktree/enforce/coordination-check).
- [x] 4. Launcher: sin worktree para el rol primario, cwd = root.
- [x] 5. Contrato del repo con `orchestrator-main` solo lectura.
- [x] 6. Skill `multi-agent-coordination`: documentar el rol sin worktree.
- [x] 7. Verificación: `vitest run` del validador + `coordination-check` real.

## Evidence

Validador global (`~/.agents/orchestration`):

- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → 7 archivos, **127 tests passed** (eran 114).
- `fallow --root .` → `check: 0 issues`, `dupes: 2` (dos grupos preexistentes en
  `test/evidence.test.ts` y `test/unbound.test.ts`), `health: 0 critical/0 high`.

Contrato real del repo, validación completa con worktrees:

```
contract ok (4 roles, ratified)
  orchestrator-main  coordination-and-integration  <primary checkout>  (1 owned)
```

Superficie del rol medida con el predicado real (`isPathAllowed`), no supuesta:

| path | decisión |
| --- | --- |
| `package.json`, `AGENTS.md`, `docs/x.md` | `shared-read-only` |
| `src/cli.ts`, `test/x.test.ts`, `scripts/x.mjs`, `.worktrees/orchestrator-a/x.ts` | `forbidden` |
| `odd/tasks/a.md` | `not-owned` |
| `.orchestration-main-readonly/notes.md` | `owned` |

Launcher: `orchestrate.sh --dry-run` ubica a `orchestrator-main` en el root con
`[primary]` y no crea nada; los otros tres siguen en sus worktrees `[exists]`.

Repo principal: `npx tsc --noEmit` → 0; `npm run build` → 0 (con
`--max-old-space-size=8192`; sin eso, el worker de DTS muere por OOM del entorno);
`fallow --root .` → `No issues found` / `No code duplication found`.
`npm run test:affected` → 1190/1191 archivos; el único fallo,
`test/connectors/legacy-capacity-parity.test.ts`, son 2 timeouts de 30s sobre un
fixture de 5 MB que pasan con `--test-timeout=120000` (3/3), y no tocan nada de
este cambio.

## What a verification pass changed

Un pase de verificación independiente encontró cuatro defectos reales, ya
corregidos:

1. **Agujero lógico**: `worktree: ""` resuelve contra el `repoRoot` que recibe el
   validador. Si un llamador pasaba un worktree enlazado, el rol primario aterrizaba
   ahí y compartía checkout con su dueño **sin reportar nada**, porque los primary
   claims están excluidos del chequeo de duplicados. Ahora
   `describeMisplacedPrimaryClaims` compara contra la primera entrada de git y lo
   rechaza. Con test propio.
2. `src/worktree.ts` se contradecía a sí mismo: el encabezado seguía diciendo
   "non-primary".
3. `src/unbound.ts` justificaba el módulo con "no role may own the primary
   checkout", falso después de este cambio.
4. `launch_role` armaba el cwd como `$root/$worktree_rel` en vez de usar
   `worktree_of_role`; funcionaba por accidente (trailing slash).

## Known limitation

El contrato está sin commitear. El hook lee el contrato del **main root**, así que
el enforcement ya es correcto para los tres roles; pero los checkouts enlazados
`.worktrees/orchestrator-{a,b,c}` tienen el contrato *commiteado* en su rama, que
todavía declara cuatro roles — incluido el ya retirado `orchestrator-c`. Commitear
el contrato antes de lanzar es lo que sincroniza ambas vistas. No se creó ni se
modificó ningún worktree; el de `orchestrator-c` quedó intacto, porque borrar un
worktree es una operación git destructiva y le corresponde al humano.

## Amendment: integration authority moved, C retired

Revisión posterior, ratificada por el humano. La forma del reparto cambió:

- **`orchestrator-main` es el único que integra.** `orchestrator-a` perdió el
  sufijo de integración en su `module` y ya no mergea. El autor de una rama nunca
  mergea su propio trabajo, así que A y B entregan y `orchestrator-main` revisa y
  mergea.
- **`odd/**` raíz es de `orchestrator-main`.** A lo perdió y ahora la tiene
  prohibida: el registro de decisiones del repositorio lo escribe quien integra,
  que es el que puede leer la rama y dejarla asentada.
- **`orchestrator-c` se retiró y se fusionó en `orchestrator-b`.** B ahora posee
  toda la dimensión KG: core, pydantic, oracle, routes, mcp y los módulos
  `ts/src/*.ts`, más el adaptador `src/dimensions/kg`. Su `forbiddenPaths` perdió
  `ts/src/*.ts`, `mcp/**`, `routes/**` y `test/dimensions/kg-*`, porque con C
  fuera esas prohibiciones habrían bloqueado a B sobre sus propios archivos.
- **El contrato no gana ningún campo nuevo.** `scope.ts` valida cada rol con
  `z.strictObject`: una clave desconocida invalida el contrato entero y, como el
  hook falla abierto, desenforcaría a todas las sesiones vivas a la vez. La
  autoridad de integración se expresa en `module`, en este documento y en la regla
  de que nadie mergea su propia rama — no en un booleano inventado.

Un detalle del merge que una unión ingenua de paths habría roto: `test/dimensions/kg-*`
estaba en el `ownedPaths` de C y en el `forbiddenPaths` de B. Copiar ambos habría
dejado `forbidden` ganando sobre `owned` y B sin poder escribir ninguno de sus
propios tests. Se quitó de las prohibiciones de B al eliminar el rol dueño.
