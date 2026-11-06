# Feature: algo-KG — open knowledge extraction with JEV classification

Dimension KG. Evolves the AKS ingestion algorithm so that source-backed knowledge is preserved even when it does not fit the configured type catalog: open extraction of entities and relations, then independent JEV classification of nodes and relations, keeping unclassified items "free" rather than false or invalid.
Branch: `feat/algo-KG`. Status: specs and tasks pending reconnaissance.

## Specs

S1. El conocimiento respaldado por las fuentes se conserva aunque no encaje en el catálogo de tipos configurado. Quote: "Conservar el conocimiento respaldado por las fuentes aunque no encaje en el catálogo de tipos configurado."

S2. El grafo admite las cuatro formas siguientes. Verbatim:
- Entidades clasificadas con un tipo canónico.
- Entidades libres, sin clasificación canónica.
- Relaciones clasificadas con un tipo canónico.
- Relaciones libres, que conservan su predicado original.

S3. "Libre" tiene un significado estricto. Quote: "“Libre” significa que no se ha podido asignar un tipo del catálogo. No significa falso, inválido ni pendiente de revisión humana."

S4. No se introduce aprobación humana obligatoria en la ingestión, y el significado de la revisión humana existente se mantiene. Quote: "No introduzcas una aprobación humana obligatoria en este flujo de ingestión. Mantén intacto el significado de los mecanismos existentes de revisión humana, incluido backfeed."

S5. Las cuatro limitaciones sospechadas se confirman o refutan contra el código real antes de diseñar. Verbatim:
- Extracción mediante `SchemaLLMPathExtractor` sin vocabulario propio.
- Máximo de 20 tripletas por fragmento.
- Confianza constante de 0.7.
- Deduplicación basada únicamente en nombres normalizados.
Quote: "No asumas que el código sigue igual: adapta la solución a lo que encuentres."

S6. La ingestión consta de estas etapas explícitas, en este orden. Verbatim:
1. Extraer candidatos de entidades y relaciones.
2. Comprobar su respaldo en las fuentes.
3. Resolver identidades.
4. Clasificar entidades mediante JEV.
5. Clasificar relaciones mediante JEV.
6. Validar estructura y compatibilidad semántica.
7. Consolidar y persistir.
8. Actualizar las proyecciones y exportaciones existentes.

S7. La extracción descubre nombres, tipos propuestos y predicados fuera del catálogo; el catálogo es orientación, no filtro. Quote: "La extracción debe descubrir nombres, tipos propuestos y predicados fuera del catálogo. Proporciona el catálogo como orientación cuando resulte útil, pero no descartes candidatos solo por no encajar en él. No dependas únicamente de `strict=False` para garantizar este comportamiento."

S8. Se admiten entidades sin relaciones. Quote: "Permite extraer entidades sin relaciones: no todo conocimiento relevante aparece como una tripleta completa."

S9. Sin promesa de exhaustividad y sin límites silenciosos. Quote: "No prometas extracción exhaustiva. Evita límites silenciosos: registra límites, truncamientos y procesamiento parcial. Si implementas pasadas adicionales de extracción, deben tener deduplicación y presupuesto acotado."

S10. Cada candidato conserva estos datos de procedencia. Verbatim:
- Documento y fragmento de origen.
- Evidencia textual.
- Referencias u offsets verificables cuando sea posible.
- Modelo y versión del pipeline.
- Tipo o predicado propuesto por el extractor.

S11. El fragmento citado debe existir en la fuente, con normalizaciones controladas. Quote: "Verifica en código que los fragmentos citados existan en la fuente, contemplando normalizaciones controladas."

S12. Se distingue evidencia textual de respaldo semántico. Verbatim:
- Evidencia encontrada textualmente.
- Evaluación semántica de que esa evidencia respalda la afirmación.
Quote: "Una cita existente no garantiza que respalde la interpretación del extractor."

S13. El contenido documental se trata como datos, nunca como instrucciones. Quote: "Procesa el contenido documental como datos, no como instrucciones para el pipeline."

S14. El catálogo se configura y versiona por Stack con estos elementos. Verbatim:
- Tipos de entidad.
- Definición y ejemplos de cada tipo.
- Tipos de relación.
- Definición, dirección y ejemplos de cada relación.
- Combinaciones permitidas de tipo origen, relación y tipo destino.
- Alias que puedan normalizarse a tipos canónicos.
Ejemplo conceptual verbatim: tipos de entidad `Role`, `Process`, `Document`, `Policy`, `System`; relaciones `Role —executes→ Process`, `Role —reviews→ Document`, `Process —requires→ Document`, `Policy —governs→ Process`, `System —supports→ Process`.

S15. El catálogo es configuración propia, no un estándar AKS. Quote: "Este catálogo es configuración de nuestra implementación, no un nuevo estándar de AKS."

S16. La ingestión nunca agrega tipos al catálogo. Quote: "No agregues automáticamente tipos nuevos al catálogo durante la ingestión. Los candidatos que no encajen deben permanecer libres."

S17. La integración con JEV se basa en documentación y SDK reales. Quote: "Consulta la documentación y SDK reales disponibles. No inventes endpoints, métodos ni formatos de respuesta."

S18. El adaptador de JEV es aislado, sustituible y comprobable con dobles. Quote: "Implementa un adaptador aislado, sustituible y comprobable con dobles de prueba."

S19. JEV recibe estos insumos, incluida la opción de abstenerse. Verbatim:
- Candidato y contexto suficiente.
- Evidencia original.
- Definiciones del catálogo.
- Opciones explícitas para abstenerse.

S20. La decisión de respaldo semántico usa este conjunto cerrado. Verbatim: `SUPPORTED`, `UNSUPPORTED`, `UNCERTAIN`.

S21. La decisión de clasificación usa este conjunto. Verbatim: "Uno de los tipos canónicos." / "`NO_MATCH`: ningún tipo del catálogo encaja." / "`UNCERTAIN`: información insuficiente o ambigua."

S22. Se conservan las probabilidades y medidas de confianza reales de JEV con su significado original. Quote: "Conserva las probabilidades y medidas de confianza que realmente proporcione JEV, con su significado original."

S23. No se confunden estas cuatro magnitudes. Verbatim:
- Confianza de extracción.
- Respaldo de una afirmación en la fuente.
- Confianza en la clasificación.
- Verificación humana.

S24. Los umbrales son configurables y deben ajustarse con evaluación del corpus. Quote: "Define umbrales configurables y documenta que deben ajustarse con evaluaciones del corpus."

S25. Un fallo de JEV conserva el trabajo extraído con estado operativo, nunca `NO_MATCH`. Quote: "Si JEV falla o agota sus reintentos, conserva el trabajo extraído con un estado operativo de clasificación pendiente o fallida. No conviertas un error del proveedor en `NO_MATCH` ni aceptes silenciosamente hechos sin evaluar."

S26. Cada entidad tiene identidad estable y estado de clasificación, distinguiendo cuatro situaciones. Verbatim:
- Clasificada.
- Libre por ausencia de coincidencia.
- Libre por ambigüedad.
- Pendiente o fallida por un problema operativo.

S27. `Concept` no sustituye a "sin clasificar". Quote: "No uses `Concept` como sustituto automático de “sin clasificar”. `Concept` solo debe asignarse si existe en el catálogo y su definición corresponde al candidato."

S28. Una entidad libre conserva capacidades plenas y se reclasifica sobre el mismo nodo. Verbatim:
- Tener propiedades y fuentes.
- Participar en relaciones.
- Aparecer en búsquedas y recorridos.
- Reclasificarse automáticamente más adelante.
Quote: "Reclasificarla debe actualizar el mismo nodo, preservando UUID, procedencia y relaciones."

S29. No hay fusión por nombre. Quote: "No fusiones entidades únicamente porque tienen el mismo nombre. Distingue menciones, alias y entidades canónicas, y evita mezclar homónimos. Cuando la identidad sea incierta, conserva la separación."

S30. Cada relación conserva estos datos. Verbatim:
- Identidad estable.
- Entidad origen y destino.
- Dirección.
- Predicado original.
- Tipo canónico, si se determina.
- Estado de clasificación.
- Evidencia y procedencia.

S31. Los predicados desconocidos no se colapsan en `related_to`. Quote: "No conviertas todos los predicados desconocidos en `related_to` perdiendo su significado." Example verbatim: "Por ejemplo, “deja sin efecto” debe conservarse aunque todavía no se normalice a `invalidates`."

S32. Nodos y relaciones se clasifican de forma independiente. Verbatim:
- Dos nodos clasificados pueden tener una relación libre.
- Dos nodos libres pueden tener una relación clasificada.

S33. La clave de deduplicación de relaciones libres preserva el predicado. Quote: "No dedupliques todas las relaciones libres usando únicamente `(origen, Unclassified, destino)`: eso fusionaría predicados distintos. Diseña una clave que preserve esas diferencias y permita reclasificación posterior."

S34. La compatibilidad de una relación con el catálogo tiene tres resultados. Verbatim:
- Tipos conocidos y compatibles: compatible.
- Tipos conocidos e incompatibles: conflicto.
- Tipo de algún extremo desconocido: compatibilidad indeterminada.

S35. Compatibilidad de esquema y respaldo en la fuente son cosas distintas. Quote: "No confundas la compatibilidad con el esquema con el respaldo en la fuente. Un hecho respaldado pero incompatible con el catálogo debe conservarse con el conflicto registrado, sin forzar su clasificación."

S36. Las migraciones son no destructivas. Quote: "Diseña migraciones no destructivas. No requieras borrar volúmenes ni reconstruir la base de datos."

S37. Antes de cambiar el formato público se revisa el esquema AKS real, con estas reglas. Verbatim:
- Conserva los campos obligatorios.
- Usa extensiones solamente donde estén permitidas.
- No presupongas que las relaciones admiten `properties`.
- Si hacen falta metadatos internos adicionales, almacénalos en columnas o tablas propias.
- Define una proyección de exportación compatible para entidades y relaciones libres.
- Conserva el predicado original y la procedencia en esa proyección.

S38. Un tipo reservado como `Unclassified` es convención propia, documentada, sin colisión con tipos del usuario. Quote: "Si necesitas un tipo reservado como `Unclassified`, documenta que es una convención de nuestra aplicación y evita colisiones con tipos del usuario."

S39. `source.verified` no se marca por decisión automática. Quote: "No marques `source.verified=true` por una decisión automática. Conserva el significado de revisión humana que tiene ese campo en AKS."

S40. Las probabilidades de JEV no se convierten automáticamente en `confidence` de AKS. Quote: "No conviertas automáticamente las probabilidades de JEV en `confidence` de AKS. Define y documenta cómo se calcula ese campo y qué mide."

S41. Se mantiene el comportamiento de endpoints y herramientas existentes, con estas reglas. Verbatim:
- Las consultas generales pueden recuperar entidades clasificadas y libres.
- Los recorridos generales pueden atravesar ambos tipos de nodos y relaciones.
- Los filtros por tipo canónico deben devolver únicamente coincidencias clasificadas.
- Permite consultar elementos libres y sus motivos.
- Las reglas de inferencia deben utilizar únicamente semántica suficientemente definida.
- Una relación libre no debe activar reglas propias de una relación canónica.

S42. El estado de clasificación se expone a consumidores y páginas. Quote: "Expón estados de clasificación para que consumidores y páginas no presenten conocimiento incierto como confirmado."

S43. Se permite reclasificar sin repetir extracción ni embeddings, con estas garantías. Verbatim:
- UUID estables.
- Ingestión repetida sin duplicados.
- Reintentos seguros.
- Conservación de múltiples evidencias.
- Cambios de clasificación trazables.
- Tratamiento seguro de relaciones que converjan al mismo tipo canónico.
- Ausencia de sobrescrituras silenciosas ante decisiones contradictorias.

S44. Las transacciones de base de datos son acotadas. Quote: "Mantén las transacciones de base de datos acotadas; evita mantenerlas abiertas durante llamadas externas largas."

S45. Las pruebas cubren estos quince escenarios. Verbatim:
1. Entidad que encaja en el catálogo.
2. Entidad respaldada que queda libre.
3. Clasificación ambigua.
4. Relación que se normaliza a un tipo conocido.
5. Relación libre que conserva su predicado.
6. Relación tipada entre nodos libres.
7. Relación libre entre nodos tipados.
8. Evidencia inexistente o que no respalda la afirmación.
9. Homónimos que no deben fusionarse.
10. Reclasificación preservando identidades y conexiones.
11. Dos predicados libres diferentes entre los mismos extremos.
12. Reingestión y reintentos sin duplicación.
13. Fallos de JEV sin pérdida de candidatos.
14. Exportación validada contra el esquema AKS.
15. Consultas y recorridos con elementos libres.

S46. Las pruebas automatizadas usan dobles de JEV; las llamadas reales son evaluación opcional y explícita. Quote: "Usa dobles de JEV para las pruebas automatizadas. Las llamadas reales deben ser una evaluación opcional y explícita."

S47. Existe un conjunto pequeño de ejemplos etiquetados, y la cobertura del extractor se evalúa por separado de la calidad del clasificador. Quote: "Prepara un conjunto pequeño de ejemplos etiquetados que permita medir errores de clasificación, respaldo y pérdida de información. Evalúa por separado la cobertura del extractor y la calidad del clasificador: JEV no puede recuperar candidatos que el extractor omitió."

S48. La entrega informa estos ocho puntos. Verbatim:
- Resumen del comportamiento final.
- Archivos modificados.
- Migraciones y pasos para ejecutarlas.
- Configuración de JEV.
- Ejemplo de catálogo.
- Ejemplo completo de ingestión con entidades y relaciones clasificadas y libres.
- Comandos y resultados de las pruebas ejecutadas.
- Limitaciones pendientes y decisiones de compatibilidad AKS.
Quote: "Prioriza una implementación incremental integrada en el proyecto. No añadas servicios, frameworks ni infraestructura que no sean necesarios para este objetivo."

## Tasks

14 tasks. Each row: ID, linked specs, route, commit subject. Route `worker` = a fresh `gentle-ai-worker` with a nonempty `## Allowed edit surfaces`. Tests for a task's behavior are written inside that task (RED first), never as a later cleanup task.

| ID | Spec | Scope | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | S14,S15,S16,S38 | Versioned per-Stack type catalog: `EntityTypeDef`, `RelationTypeDef`, `RelationConstraint`, aliases; loader with fallback from legacy `stacks.ontology`; resolver for alias→canonical; documented default catalog (`Role`,`Process`,`Document`,`Policy`,`System` + the five example relations). Never mutates the catalog during ingestion. | worker | `feat(kg): add versioned per-stack type catalog` |
| T2 | S36,S10,S26,S30,S43 | Non-destructive migration `db/migration_open_kg_classification.sql`: new columns on `ontology_entities`/`ontology_relationships`, `kg_evidence`, `kg_classification_log`, `stacks.type_catalog` + `catalog_version`; backfill existing rows as classified; replace name-only uniqueness with an identity key. No volume reset, no rebuild. High-risk: own commit, no behavior change bundled. | worker | `5f156b7` + `4fb10aa` |
| T3 | S10,S11,S12,S13 | Evidence stage: normalized quote existence check with verifiable offsets, textual-vs-semantic split, document content handled as data. Scenario S45.8. | worker | `497f477` |
| T4 | S5,S7,S8,S9 | Open candidate extraction: names, proposed types and predicates outside the catalog; catalog as orientation only; entities with no relations; no reliance on `strict=False`; bounded retry budget with dedup and logged truncation/partial processing. | worker | `3051f47` |
| T5 | S26,S28,S29 | Identity resolution: stable UUIDs, mention/alias/canonical distinction, homonyms not merged, separation preserved when identity is uncertain. Scenario S45.9. | worker | `7bdbc46` |
| T6 | S17,S18,S19,S20,S21,S22,S23,S24 | JEV adapter: substitutable `JevDecisionClient` over the documented `POST https://api.typesafe.ai/v1/systemone` contract (`state` + `questions`, `noul`/`choice`), query builder sending candidate, context, original evidence and catalog definitions with explicit abstain options; SUPPORTED/UNSUPPORTED/UNCERTAIN and canonical-type/NO_MATCH/UNCERTAIN parsing; raw probabilities and confidence kept with their original meaning; configurable thresholds; provider failure or exhausted retries becomes a pending/failed operational state, never NO_MATCH. Default suite uses doubles only. | worker | `b958a38` |
| T7 | S26,S27 | Entity classification states `classified` / `free_no_match` / `free_uncertain` / `pending` / `failed`; `Concept` never used as the stand-in for unclassified. Scenarios S45.1, S45.2, S45.3. | worker | `498ea6b` |
| T8 | S30,S31,S32,S33 | Relation classification with the original predicate always preserved, never collapsed into `related_to`; free-relation dedup key that keeps distinct predicates apart; nodes and relations classified independently. Scenarios S45.4, S45.5, S45.11. | worker | `498ea6b` |
| T9 | S34,S35 | Endpoint-type compatibility: compatible / conflict / indeterminate, kept separate from source support; a supported but incompatible fact is retained with the conflict recorded. Scenarios S45.6, S45.7. | worker | `498ea6b` |
| T10 | S1,S2,S3,S4,S6 | Wire the eight stages in order into `routes/ingest/pipeline.ts`; no mandatory human approval added; backfeed keeps setting `verified=true`, `source_kind='backfeed'`, `pipeline='human-review'` unchanged. | worker | `c38c035` (extraction half) + `f6cca2e` (open contract on ingest) + `00b8aea` (stage wiring, classification, persistence) + `b438d57` (contract pin) + `1454656` (original predicate + semantic support) + `e184ee6` (stack's own catalog) + `276e13c` (extraction outside the transaction) |
| T11 | S37,S38,S39,S40 | AKS projection for free entities and relations: original predicate preserved in the export, entity extension only inside the allowed `properties`, relationship metadata kept in own columns because AKS forbids extra relationship fields, documented `confidence` formula, `source.verified` never set automatically. Scenario S45.14. Lands together with `757de92` — see the ordering defect in L13. | worker | `6727f99` |
| T12 | S41,S42 | Read path: canonical-type filters return only classified matches, general queries and traversals cross both kinds, free items queryable with their reasons, classification state exposed; no rule fires on a free relation. Scenario S45.15. Landed second in time, first in a bisect (L13). | worker | `757de92` |
| T13 | S43,S44 | Reclassification and reprocessing by catalog/classifier version without repeating extraction or embeddings; stable UUIDs, no duplicate ingestion, safe retries, multiple evidences retained, traceable changes, convergent canonical types handled safely, no silent overwrite, bounded transactions with no open transaction across provider calls. Scenarios S45.10, S45.12, S45.13. | worker | `feat(kg): reclassify idempotently without re-extraction` |
| T14 | S46,S47 | Labeled example set plus an optional, explicit real-JEV evaluation script that scores classification error, support quality and information loss, and measures extractor coverage separately from classifier quality. | worker | `feat(kg): add labeled eval set and optional JEV run` |
| T15 | S48 | Documentation: classification guide, migration runbook with exact commands, catalog example, JEV configuration and threshold-tuning guidance, end-to-end ingestion example with classified and free entities and relations. | worker | `docs(kg): document open classification and JEV setup` |
| T16 | S48 | Closing gates on `feat/algo-KG`: `npx tsc --noEmit`, `npm run build`, `npm run test:affected`, `fallow`; one differential check against the base commit for every command sharing changed code; rebase onto updated primary preserving the sibling 50-concept prompt cap as a named constant. No commit of its own. | verify | — |

## Log

### L1 — user request, verbatim (Spanish)

Project 1: feat/algo-KG
en el contexto de la dimension KG: Implementa una evolución del algoritmo de ingestión de AKS que combine extracción abierta de conocimiento con clasificación automática mediante JEV.

Trabaja sobre el código existente y completa la implementación, migraciones, documentación y pruebas necesarias. Primero revisa las instrucciones del repositorio y verifica el comportamiento real del pipeline; los nombres de archivos mencionados aquí son orientativos.

## Objetivo

Conservar el conocimiento respaldado por las fuentes aunque no encaje en el catálogo de tipos configurado.

El grafo debe permitir:

- Entidades clasificadas con un tipo canónico.
- Entidades libres, sin clasificación canónica.
- Relaciones clasificadas con un tipo canónico.
- Relaciones libres, que conservan su predicado original.

“Libre” significa que no se ha podido asignar un tipo del catálogo. No significa falso, inválido ni pendiente de revisión humana.

No introduzcas una aprobación humana obligatoria en este flujo de ingestión. Mantén intacto el significado de los mecanismos existentes de revisión humana, incluido backfeed.

## 1. Inspección inicial

Revisa especialmente:

- Extracción y fragmentación de documentos.
- `app/core/extraction.py`.
- Consolidación y resolución de identidades.
- Endpoint de ingestión.
- Esquema de Postgres y migraciones.
- Serializadores AKS y formato de exportación.
- Consultas, filtros por tipo y recorridos del grafo.
- Generación de descripciones y páginas.
- Integraciones y configuración del proveedor de inferencia.

Comprueba si siguen existiendo estas limitaciones:

- Extracción mediante `SchemaLLMPathExtractor` sin vocabulario propio.
- Máximo de 20 tripletas por fragmento.
- Confianza constante de 0.7.
- Deduplicación basada únicamente en nombres normalizados.

No asumas que el código sigue igual: adapta la solución a lo que encuentres.

## 2. Separa extracción, evidencia y clasificación

Implementa etapas explícitas:

1. Extraer candidatos de entidades y relaciones.
2. Comprobar su respaldo en las fuentes.
3. Resolver identidades.
4. Clasificar entidades mediante JEV.
5. Clasificar relaciones mediante JEV.
6. Validar estructura y compatibilidad semántica.
7. Consolidar y persistir.
8. Actualizar las proyecciones y exportaciones existentes.

La extracción debe descubrir nombres, tipos propuestos y predicados fuera del catálogo. Proporciona el catálogo como orientación cuando resulte útil, pero no descartes candidatos solo por no encajar en él. No dependas únicamente de `strict=False` para garantizar este comportamiento.

Permite extraer entidades sin relaciones: no todo conocimiento relevante aparece como una tripleta completa.

No prometas extracción exhaustiva. Evita límites silenciosos: registra límites, truncamientos y procesamiento parcial. Si implementas pasadas adicionales de extracción, deben tener deduplicación y presupuesto acotado.

## 3. Evidencia y procedencia

Cada candidato debe conservar:

- Documento y fragmento de origen.
- Evidencia textual.
- Referencias u offsets verificables cuando sea posible.
- Modelo y versión del pipeline.
- Tipo o predicado propuesto por el extractor.

Verifica en código que los fragmentos citados existan en la fuente, contemplando normalizaciones controladas.

Distingue entre:

- Evidencia encontrada textualmente.
- Evaluación semántica de que esa evidencia respalda la afirmación.

Una cita existente no garantiza que respalde la interpretación del extractor.

Procesa el contenido documental como datos, no como instrucciones para el pipeline.

## 4. Catálogo de tipos configurable por Stack

Permite configurar y versionar:

- Tipos de entidad.
- Definición y ejemplos de cada tipo.
- Tipos de relación.
- Definición, dirección y ejemplos de cada relación.
- Combinaciones permitidas de tipo origen, relación y tipo destino.
- Alias que puedan normalizarse a tipos canónicos.

Ejemplo conceptual:

- `Role`
- `Process`
- `Document`
- `Policy`
- `System`

Relaciones:

- `Role —executes→ Process`
- `Role —reviews→ Document`
- `Process —requires→ Document`
- `Policy —governs→ Process`
- `System —supports→ Process`

Este catálogo es configuración de nuestra implementación, no un nuevo estándar de AKS.

No agregues automáticamente tipos nuevos al catálogo durante la ingestión. Los candidatos que no encajen deben permanecer libres.

## 5. Integración con JEV

Consulta la documentación y SDK reales disponibles. No inventes endpoints, métodos ni formatos de respuesta.

Implementa un adaptador aislado, sustituible y comprobable con dobles de prueba.

JEV debe recibir:

- Candidato y contexto suficiente.
- Evidencia original.
- Definiciones del catálogo.
- Opciones explícitas para abstenerse.

Separa al menos estas decisiones:

### Respaldo semántico

- `SUPPORTED`
- `UNSUPPORTED`
- `UNCERTAIN`

### Clasificación

- Uno de los tipos canónicos.
- `NO_MATCH`: ningún tipo del catálogo encaja.
- `UNCERTAIN`: información insuficiente o ambigua.

Conserva las probabilidades y medidas de confianza que realmente proporcione JEV, con su significado original.

No confundas:

- Confianza de extracción.
- Respaldo de una afirmación en la fuente.
- Confianza en la clasificación.
- Verificación humana.

Define umbrales configurables y documenta que deben ajustarse con evaluaciones del corpus.

Si JEV falla o agota sus reintentos, conserva el trabajo extraído con un estado operativo de clasificación pendiente o fallida. No conviertas un error del proveedor en `NO_MATCH` ni aceptes silenciosamente hechos sin evaluar.

## 6. Entidades clasificadas y libres

Representa las entidades con una identidad estable y un estado de clasificación.

Distingue:

- Clasificada.
- Libre por ausencia de coincidencia.
- Libre por ambigüedad.
- Pendiente o fallida por un problema operativo.

Usa los nombres concretos que mejor encajen en el repositorio, pero conserva estas diferencias.

No uses `Concept` como sustituto automático de “sin clasificar”. `Concept` solo debe asignarse si existe en el catálogo y su definición corresponde al candidato.

Una entidad libre puede:

- Tener propiedades y fuentes.
- Participar en relaciones.
- Aparecer en búsquedas y recorridos.
- Reclasificarse automáticamente más adelante.

Reclasificarla debe actualizar el mismo nodo, preservando UUID, procedencia y relaciones.

No fusiones entidades únicamente porque tienen el mismo nombre. Distingue menciones, alias y entidades canónicas, y evita mezclar homónimos. Cuando la identidad sea incierta, conserva la separación.

## 7. Relaciones clasificadas y libres

Cada relación debe conservar:

- Identidad estable.
- Entidad origen y destino.
- Dirección.
- Predicado original.
- Tipo canónico, si se determina.
- Estado de clasificación.
- Evidencia y procedencia.

No conviertas todos los predicados desconocidos en `related_to` perdiendo su significado.

Por ejemplo, “deja sin efecto” debe conservarse aunque todavía no se normalice a `invalidates`.

Clasifica nodos y relaciones independientemente:

- Dos nodos clasificados pueden tener una relación libre.
- Dos nodos libres pueden tener una relación clasificada.

No dedupliques todas las relaciones libres usando únicamente `(origen, Unclassified, destino)`: eso fusionaría predicados distintos. Diseña una clave que preserve esas diferencias y permita reclasificación posterior.

Si una relación tiene restricciones sobre los tipos de sus extremos:

- Tipos conocidos y compatibles: compatible.
- Tipos conocidos e incompatibles: conflicto.
- Tipo de algún extremo desconocido: compatibilidad indeterminada.

No confundas la compatibilidad con el esquema con el respaldo en la fuente. Un hecho respaldado pero incompatible con el catálogo debe conservarse con el conflicto registrado, sin forzar su clasificación.

## 8. Persistencia e interoperabilidad AKS

Diseña migraciones no destructivas. No requieras borrar volúmenes ni reconstruir la base de datos.

Antes de modificar el formato público, revisa el esquema AKS real:

- Conserva los campos obligatorios.
- Usa extensiones solamente donde estén permitidas.
- No presupongas que las relaciones admiten `properties`.
- Si hacen falta metadatos internos adicionales, almacénalos en columnas o tablas propias.
- Define una proyección de exportación compatible para entidades y relaciones libres.
- Conserva el predicado original y la procedencia en esa proyección.

Si necesitas un tipo reservado como `Unclassified`, documenta que es una convención de nuestra aplicación y evita colisiones con tipos del usuario.

No marques `source.verified=true` por una decisión automática. Conserva el significado de revisión humana que tiene ese campo en AKS.

No conviertas automáticamente las probabilidades de JEV en `confidence` de AKS. Define y documenta cómo se calcula ese campo y qué mide.

## 9. Consultas y recorridos

Mantén el comportamiento de los endpoints y herramientas existentes.

- Las consultas generales pueden recuperar entidades clasificadas y libres.
- Los recorridos generales pueden atravesar ambos tipos de nodos y relaciones.
- Los filtros por tipo canónico deben devolver únicamente coincidencias clasificadas.
- Permite consultar elementos libres y sus motivos.
- Las reglas de inferencia deben utilizar únicamente semántica suficientemente definida.
- Una relación libre no debe activar reglas propias de una relación canónica.

Expón estados de clasificación para que consumidores y páginas no presenten conocimiento incierto como confirmado.

## 10. Reprocesamiento e idempotencia

Permite reclasificar entidades y relaciones existentes cuando cambie la versión del catálogo o del clasificador, sin repetir innecesariamente extracción y embeddings.

Asegura:

- UUID estables.
- Ingestión repetida sin duplicados.
- Reintentos seguros.
- Conservación de múltiples evidencias.
- Cambios de clasificación trazables.
- Tratamiento seguro de relaciones que converjan al mismo tipo canónico.
- Ausencia de sobrescrituras silenciosas ante decisiones contradictorias.

Mantén las transacciones de base de datos acotadas; evita mantenerlas abiertas durante llamadas externas largas.

## 11. Validación y pruebas

Incluye pruebas significativas para:

1. Entidad que encaja en el catálogo.
2. Entidad respaldada que queda libre.
3. Clasificación ambigua.
4. Relación que se normaliza a un tipo conocido.
5. Relación libre que conserva su predicado.
6. Relación tipada entre nodos libres.
7. Relación libre entre nodos tipados.
8. Evidencia inexistente o que no respalda la afirmación.
9. Homónimos que no deben fusionarse.
10. Reclasificación preservando identidades y conexiones.
11. Dos predicados libres diferentes entre los mismos extremos.
12. Reingestión y reintentos sin duplicación.
13. Fallos de JEV sin pérdida de candidatos.
14. Exportación validada contra el esquema AKS.
15. Consultas y recorridos con elementos libres.

Usa dobles de JEV para las pruebas automatizadas. Las llamadas reales deben ser una evaluación opcional y explícita.

Prepara un conjunto pequeño de ejemplos etiquetados que permita medir errores de clasificación, respaldo y pérdida de información. Evalúa por separado la cobertura del extractor y la calidad del clasificador: JEV no puede recuperar candidatos que el extractor omitió.

## Entrega

Implementa la solución y termina con:

- Resumen del comportamiento final.
- Archivos modificados.
- Migraciones y pasos para ejecutarlas.
- Configuración de JEV.
- Ejemplo de catálogo.
- Ejemplo completo de ingestión con entidades y relaciones clasificadas y libres.
- Comandos y resultados de las pruebas ejecutadas.
- Limitaciones pendientes y decisiones de compatibilidad AKS.

Prioriza una implementación incremental integrada en el proyecto. No añadas servicios, frameworks ni infraestructura que no sean necesarios para este objetivo.

### L2 — Verdicts on the four suspected limitations (reconnaissance evidence)

Checked against the real tree. `app/core/extraction.py` does not exist: the KG package is TypeScript only, under `packages/llmwiki-kg/ts/src`.

- "Extracción mediante `SchemaLLMPathExtractor` sin vocabulario propio" — REFUTED. Extraction is tool-call structured output; the vocabulary is caller-supplied via `stacks.ontology` (`core/ontology-gate.ts`, `loadStackOntology`) with fallback `core/default_ontology.ts`.
- "Máximo de 20 tripletas por fragmento" — REFUTED. No such constant exists; chunking is `core/chunking.ts`, `DEFAULT_CHUNK_SIZE=1024`, `DEFAULT_CHUNK_OVERLAP=200`.
- "Confianza constante de 0.7" — CONFIRMED. `EXTRACTED_CONFIDENCE = 0.7` in `core/extraction-types.ts` stamps every extracted entity and relationship.
- "Deduplicación basada únicamente en nombres normalizados" — CONFIRMED for entities: the DB constraint `unique_name_per_stack unique (stack_id, name)` plus `lower(name)` lookups in `core/document-consolidation.ts`. Relationships already dedup on `(stack_id, from_entity_id, to_entity_id, type)`.

Two further refutations matter for the design: `Concept` as an unclassified default and a `related_to` fallback predicate do not exist in production code, so no coercion has to be undone; and no inference-rule engine exists, so "free relations must not trigger canonical-relation rules" is a constraint on what must not be introduced. The only inference-like surface is the `subtypes` / `parentsOf` hierarchy.

### L3 — JEV is a real, documented service

"JEV" resolves to Jev (TypeSafe AI "System One"), a typed-decision API rather than a text LLM: `POST https://api.typesafe.ai/v1/systemone`, bearer auth, body `{ model, state, questions }`, primitives `noul` / `choice` / `score`, response `{ answers: { <id>: { choice, probabilities, confidence } }, usage }`. Sources: `https://docs.typesafe.ai/api/system-one`, `https://docs.typesafe.ai/primitives/choice`, `https://docs.typesafe.ai/confidence`, `https://docs.typesafe.ai/patterns/companion-noul`, `https://docs.typesafe.ai/cookbooks/citation_check`.

No JEV SDK exists in this repository and no dependency is needed: the adapter speaks the documented HTTP contract behind an interface exercised by doubles. The vendor documents no native abstain flag; abstention is expressed as a companion `noul` question plus confidence bands, which is exactly the `NO_MATCH` / `UNCERTAIN` split S20-S21 requires. The vendor also warns that `confidence` is a derived dispersion measure and not the probability the answer is correct, which is the authority for keeping the four magnitudes of S23 separate. Jev cannot emit arbitrary predicates, so the original predicate string must be captured by our own extractor and persisted by our own code.

### L4 — Architecture decisions binding the tasks

- Stored `type` on `ontology_entities`/`ontology_relationships` stays the projection/display value and remains `NOT NULL`; the catalog classification lives in new nullable `canonical_type` plus `classification_state`. Canonical type is set only when the state is `classified`.
- The original relation predicate is stored in a new immutable `predicate` column. AKS forbids extra relationship fields, so relation classification metadata stays in our own columns and tables and is exposed through our own query surface, never smuggled into the AKS wire object.
- Name-only uniqueness is replaced by an identity key so homonyms are not merged; existing rows are backfilled rather than rebuilt (S36).
- AKS `confidence` is computed by our own documented formula, never a raw JEV probability (S40); `source.verified` is only ever set by human review or approved backfeed (S39, S4).
- Entity classification metadata is exported inside the entity's already-permitted `properties` object, which is the only extension point the vendored schema allows.
- The emitted `aks_version` stays `"0.2.0"`: changing a public version string is a contract break nobody asked for. The vendored `SCHEMA.json` pins `"0.1.0"`; this discrepancy is recorded as a known limitation rather than silently altered.

### L5 — Export ordering became explicit (contract note)

Decision taken while landing T2 (`5f156b7`), recorded here because it changes an existing response and was NOT requested by the feature.

- **Before this branch** `GET /aks/v1/export` selected entities with no `ORDER BY`, so the bundle's entity order was whatever plan Postgres picked. It was heap/insert order only because `idx_entities_stack(stack_id)` was the sole stack-leading index.
- **T2's required shape changed it.** `unique (stack_id, identity_key)` and the plain `(stack_id, name)` index are both stack-leading, so the planner now picks one of them for a bare `stack_id` filter and returns identity-key/name order instead. Measured with `EXPLAIN` in a throwaway database: `Index Scan using idx_entities_stack_name`; with that index dropped, `Index Scan using unique_identity_per_stack`. `packages/llmwiki-kg/ts/src/routes/aks-export.test.ts` failed as the first observable symptom.
- **The fix is an explicit deterministic order in the production queries, never an edited expectation alone.** New orders, each a total order with a deterministic tie-break:
  - `routes/aks/export.ts` entities: `order by name, id`.
  - `routes/aks/export.ts` relationships: `order by type, from_entity_id, to_entity_id` (unique inside a Stack via `unique_edge_per_stack`).
  - `routes/aks/context.ts` catalog: `order by confidence desc, name, id` (adds a tie-break where a `limit` made the selected set plan-dependent).
  - `routes/aks/context.ts` selected entities: `order by name, id`; internal relationships: `order by type, from_entity_id, to_entity_id`.
  - `core/stack_graph.ts` edges: `order by confidence desc, type, from_entity_id, to_entity_id`; nodes gain `, id` because `name` stopped being unique when the identity key replaced `unique (stack_id, name)`.
- **Audited and left alone**, each order-independent or already explicit: `core/graph_read.ts` (`readEntities` already `confidence desc, name`; `walkStatement` already `depth, ef.name`), `core/page/context-read.ts` and `routes/pages/all-pages.ts` (explicit orders), `routes/ingest/pipeline.ts` (counts only), `export.ts` documents (`ingested_at desc`, `stack_documents` untouched by this migration).
- **Reported, not fixed by T2** because they need a read-path decision rather than an ordering one: `routes/synthesize/backfill.ts` and `routes/synthesize/description.ts:fetchEntityNames` still read collections with no order; `core/graph_read.ts` (`readEntityByName`), `core/consolidation.ts` (`findEntityIdByName`, `findExistingEntity`), `routes/pages/one-page.ts` and `routes/synthesize/one-entity.ts` still pick `rows[0]` of a `lower(name)` match, which is arbitrary now that homonyms are legal. Owned by T12/T5.
- This is a deliberate response to an index-induced change nobody asked for. It is not a product decision to re-spec the export: it states the order that endpoint always meant, and it removes the plan from the contract.

### L6 — T3 and T5 landed

Two independent new directories landed as separate work units, each staging only its own path.

- **T3 — evidence stage** (`497f477`, `feat(kg): verify evidence quotes against source text`), `packages/llmwiki-kg/ts/src/core/evidence/`, 19 tests: exact-then-normalized quote location with offsets into the original chunk text, `not_found` with no substitute span, textual presence structurally separated from semantic support, a validating provenance builder, one untrusted-data framing helper (S13). Scenario S45.8.
- **T5 — identity resolution** (`7bdbc46`, `feat(kg): resolve identities without name merging`), `packages/llmwiki-kg/ts/src/core/identity/`, 18 tests: stored identity key byte-identical to the landed `kg_entity_identity_key` trigger for bare names, disambiguated keys for homonyms, exact-then-folded comparison for bare mentions only, `matched` echoing the existing row identity so the caller updates that same row (S28). Scenario S45.9.

**Gate caveat — read this before treating (b) as verified.** The six gates (root `tsc`, package `tsc`, `build`, focused 37-test run, `test:affected`, `fallow`) ran ONCE over the combined tree with both directories present, before any commit. Commit (a) and commit (b) were therefore never independently verified in isolation; only the combined tree is green. That is acceptable only because the two directories are independent — disjoint new files, no import between them, no modification of any existing file — so neither can affect the other's result, and each worker observed its own suite green on its own directory (19 and 18 tests, reproducing as 6 files / 37 tests combined). A future task that makes one commit depend on the other must re-verify after that dependency lands.

**Gate 6 proves nothing about these two directories.** `.fallowrc.json` `ignorePatterns` contains `packages/llmwiki-kg/**`, so `npx fallow` succeeds at exit 0 with `0 above threshold · 15976 analyzed` without having analyzed a single line added here. Do not read that green as coverage of T3 or T5.

**Handoff risks carried forward from the workers, both binding on T10 (pipeline wiring):**

- `locateQuoteInChunks` returns the FIRST chunk containing the whole quote. With overlapping chunks (`DEFAULT_CHUNK_OVERLAP=200`, `core/chunking.ts`) two chunks can both contain it, so the recorded `chunkIndex` need not be the chunk the extractor actually read. T10 should pass the extractor's own chunk rather than searching all chunks of a document.
- Offsets are valid only against the stored `document_chunks.content`. That column matches the text handed in here only because `chunking.ts` stores the trimmed chunk; T10 must pass stored content, never the pre-trim split, or every offset silently shifts.

Not yet done, unchanged by this landing: nothing is exported from `core-index.ts` (deliberately T10's surface), alias-link persistence does not exist, and the legacy name-only pickers listed in L5 (`core/consolidation.ts` `findEntityIdByName` / `findExistingEntity`, `routes/pages/one-page.ts`, `routes/synthesize/one-entity.ts`) still run in the read path until T10/T12.

### L7 — Correction: the 20-triplet cap is real (supersedes one L2 bullet)

This entry is append-only and corrects exactly ONE verdict of L2. L2 is left intact below/above as written; where they disagree, this entry wins for that single bullet only.

- **The L2 verdict "Máximo de 20 tripletas por fragmento — REFUTED" is WRONG. The suspected limitation is CONFIRMED**, as a **prompt-level cap**, not as a hard post-parse truncation. Evidence:
  - `packages/llmwiki-kg/ts/src/core/graph-prompt.ts:298` declares `const MAX_TRIPLETS_PER_CHUNK = 20;`
  - `packages/llmwiki-kg/ts/src/core/graph-prompt.ts:328` substitutes it into `EXTRACTION_PROMPT` via `{max_triplets_per_chunk}`, so the legacy pipeline asks the model for at most 20 triplets per chunk. The prompt string itself carries `"Try to limit to the output {max_triplets_per_chunk} extracted triplets"`.
  - `packages/llmwiki-kg/ts/src/routes/ingest-ontology.test.ts:385` asserts the same fact in a comment (`MAX_TRIPLETS_PER_CHUNK is 20, so a many-chunk document can reject hundreds`), so the cap is already part of the observable behaviour another test depends on.
  - The cap is a request to the model, so nothing in the pipeline truncates a returned list of 21 to 20: it bounds what is asked for, and an over-eager model can still exceed it. That distinction matters for S9 — it is one of the limits that must be logged rather than silently trusted — and it is why the cap cannot be "fixed" by adding a slicing step.
- **Root cause of the earlier error:** the first reconnaissance grepped the root `src/` tree instead of `packages/llmwiki-kg/ts/src`, so it never saw `core/graph-prompt.ts` at all. Every verdict in L2 that depends on a file under `packages/llmwiki-kg/ts/src` was later re-checked against the correct tree; only this one had been reached by absence of evidence.
- **The other three L2 verdicts stand unchanged:**
  - No `SchemaLLMPathExtractor` — REFUTED stands (extraction is tool-call structured output).
  - `EXTRACTED_CONFIDENCE = 0.7` — CONFIRMED stands.
  - Name-based entity dedup — CONFIRMED stands via `unique_name_per_stack` plus `lower(name)` lookups.
- **Second finding from the same greps, binding on T10:** `packages/llmwiki-kg/ts/src/core/ontology-prompt-wiring.test.ts:115` asserts the extraction tool schema exposes `["triplets", "entities"]` as its properties, and `:126` asserts both arrays are required. So the tool schema **already** carries a separate `entities` array beside `triplets`, which means entity-only extraction may already be schema-supported. **T10 must therefore ADAPT the existing prompt and parser where they already allow this, and must not build a second parallel extraction path.** A parallel path would duplicate `buildToolSchema`, `buildExtractionPrompt` and the triplet parser, and would fork the one contract the model is already told to satisfy.

### L8 — T4 and T6 landed, with the same isolation caveat as L6

Two independent new directories landed as separate work units, each staging only its own path.

- **T4 — open candidate extraction** (`3051f47`, `feat(kg): extract open candidates without catalog filtering`), `packages/llmwiki-kg/ts/src/core/candidates/`, 24 tests across 3 test files (`parse`, `budget`, `contract`): an open candidate model carrying the extractor's proposed type and predicate, budget and truncation accounting that reports limits and partial processing instead of hiding them (S9), and an extraction contract that returns entities with no relations (S8). The catalog is orientation only, never a filter (S7).
- **T6 — JEV decision adapter** (`b958a38`, `feat(kg): add substitutable JEV decision adapter`), `packages/llmwiki-kg/ts/src/core/jev/`, 41 tests across 7 test files (`types`/`config`, `payload`, `questions`, `client`, `interpret-*` split by decision, `doubles`, `request-example`): a substitutable `JevDecisionClient` over the documented `POST /v1/systemone` contract with `state` + `questions` and `noul`/`choice` primitives, request builders that carry the candidate, context, original evidence and catalog definitions plus an explicit companion `noul` (S19), interpretation that keeps raw probabilities and confidence at their original meaning (S22) and separates support from classification (S20, S21, S23), configurable corpus-tuned thresholds (S24), and provider failure or exhausted retries becoming a pending/failed operational state rather than `NO_MATCH` (S25). The scripted double ships on the public surface because S46 makes doubles part of the contract, not a private test helper.
- **`request-example.test.ts` is a documentation device, not new behaviour.** It builds one entity-classification request through the public builder with a Spanish candidate and prints it as JSON so T15 can quote observed output instead of a hand-written snippet that drifts from the builder. It asserts three facts — the `choice` criteria keys are exactly the catalog's canonical entity type names, the companion `noul` question is present, and the evidence quote survives verbatim — so the printed example cannot quietly stop being a valid example.

**Gate caveat — same shape as L6, read it before treating either SHA as independently verified.** The six gates (root `tsc`, package `tsc`, `npm run build`, the focused run, `npm run test:affected`, `npx fallow`) ran ONCE over the combined tree with both directories present, before either commit. Gate 4 observed `9 files / 64 tests`; after `request-example.test.ts` was added the same command observes `10 files / 65 tests`, and both typechecks were re-run green with that file present. Neither commit was verified in isolation, which is acceptable only because the two directories are disjoint new files with no import between them and no modification of any existing file — each worker observed its own suite green on its own directory (24 and 40 tests). A later task that makes one depend on the other must re-verify after that dependency lands.

**Gate 5 result:** `npm run test:affected` → 741 passed | 3 skipped files, 5737 passed | 4 skipped tests, 0 failed.

**Gate 6 proves nothing about these two directories**, exactly as recorded in L6: `.fallowrc.json` `ignorePatterns` contains `packages/llmwiki-kg/**`, so `npx fallow` exits 0 with `0 above threshold · 15976 analyzed` without analyzing a single added line.

**Branch slice warning, reported not fixed.** The pre-commit advisor warns that `feat/algo-KG` is now ~29.5k authored changed lines across 106 commits against `origin/main`, far past the ~400-line reviewable slice. That is a property of the accumulated feature branch and of the base this branch was cut from, not of either landing above; each of the two commits here is a self-contained new directory of roughly 1.7k and 3.9k lines respectively. Splitting the historical branch is a delivery decision for the parent, not something a landing commit can retroactively fix.

### L9 — Extraction openness, classification stage, and what was already there

**The four commits, each staging only its own paths.**

- `498ea6b` `feat(kg): classify entities and relations independently` — T7, T8 and T9 in one unit, `packages/llmwiki-kg/ts/src/core/classify/` only (28 tests across 4 test files: `entity-classification`, `relation-classification`, `compatibility`, `classify-batch`). Entity states `classified` / `free_no_match` / `free_uncertain` / `pending` / `failed`; `Concept` never a stand-in for unclassified (S26, S27). Original relation predicate kept unconditionally, never collapsed to `related_to` (S31); the free-relation dedup key carries the folded predicate (S33); nodes and relations classified through separate entry points (S32); endpoint compatibility recorded as compatible / conflict / indeterminate beside source support (S34, S35). Scenarios S45.1-S45.7 and S45.11.
- `c38c035` `feat(kg): admit out-of-catalog candidates during extraction` — T10a: `core/graph-prompt.ts`, `core/ontology.ts` (one export), `core/open-admission.ts` (new), `core/open-extraction-contract.test.ts` (new, 22 tests).
- `b16f43b` `docs(kg): correct stale constant names and the JEV example model` — comment text in `core/candidates/budget.ts` and `routes/ingest-ontology.test.ts`, plus the JEV example model id (below). No logic touched.
- `docs(kg): record T7-T10 evidence` — this document.

**Entity-only extraction was ALREADY supported before this feature; the feature pins it and widens it.** Verified in the tree, not inferred: `core/graph-prompt.ts` `KG_TOOL` exposes `triplets` and `entities` as its two properties with both required (asserted since before this branch by `core/ontology-prompt-wiring.test.ts:115` and `:126`); `parseStandaloneEntities` exists at `core/graph-parse.ts:177`; `core/graph-extraction.ts` calls `standaloneFor(argumentsJson, ontology)` at `:166` and `:224`, which delegates to `admitStandaloneEntities` when an ontology is present; `admitStandaloneEntities` is `core/ontology.ts:638`. So the schema, the parser and the admission step all already carried entities without relations. What the strict path did **not** do is admit them openly: `core/ontology.ts:642` filters them through `isEntityTypeAllowed`, dropping every standalone entity whose declared type is outside the catalog. The open path removes exactly that filter and admits the entity with its proposed type preserved, which is the extension S7/S8 asked for.

**The 20-triplet cap is now a configurable default with a visible record.** `MAX_TRIPLETS_PER_CHUNK = 20` became `DEFAULT_MAX_TRIPLETS_PER_CHUNK` (`core/graph-prompt.ts:395`), overridable per run through `TripletBudgetOptions.maxTripletsPerChunk`. Exceeding it yields a `TripletTruncation` record naming the limit and the number dropped instead of a silent drop, so a bounded answer is legible as bounded (S9). This matches the L7 correction: the cap is real as a prompt-level bound, and it still bounds what is asked for rather than slicing what came back.

**No existing caller changes behaviour.** The strict path — `parseTripletsWithOntology`, `admitStandaloneEntities`, `buildToolSchema` — is byte-for-byte unchanged; openness lives in separate, explicit builders (`admitOpenTriplets` and the open prompt/schema builders), and `normalizeType` gained only an `export` so the open path folds labels with the one same rule instead of a second copy. `core/graph-extraction.ts` therefore keeps its current semantics: this landing adds capability beside the pipeline, not inside it.

**Carried-forward risks, both still open.**

1. **Production extraction stays closed until the pipeline task switches it.** `core/graph-extraction.ts:163` still calls `buildToolSchema` and `:180` still calls `parseTripletsWithOntology`, so the deployed ingest path neither sees the open builders nor the truncation records yet. T10's remaining half is the wiring, and it must switch the extractor rather than run both paths.
2. **Endpoint-type compatibility is not recorded on the open path.** `core/classify/compatibility.ts` can decide compatible / conflict / indeterminate (S34), but nothing in the open extraction or admission code calls it yet, so an open candidate arrives without that verdict. It is a classification-stage concern that the wiring has to feed from the classified endpoint types.

**Corrected JEV example model id.** `core/jev/request-example.test.ts` passed `model: "systemone-latest"`, an identifier nobody publishes — the vendor alias is `jev-latest` and the production default is `DEFAULT_JEV_MODEL = "jev-latest"` (`core/jev/config.ts:43`). The example now passes that constant and asserts the built request's `model` equals the literal `"jev-latest"`, so the documented request cannot drift back to an invented id without failing. This matters beyond tidiness: T15 quotes this printed JSON in the delivery documentation, and `confidence` semantics aside, an example request naming a nonexistent model is a wrong onboarding instruction.

**Gates over the combined tree, run once before committing (all six green).**

- `npx tsc --noEmit` → exit 0.
- `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit` → exit 0.
- `npm run build` → exit 0, `ESM Build success`, `DTS Build success`.
- Focused vitest over `core/classify`, `core/open-extraction-contract.test.ts` and `core/jev/request-example.test.ts` → `6 passed (6)` files, `51 passed (51)` tests.
- `npm run test:affected` → `747 passed | 3 skipped (750)` files, `5788 passed | 4 skipped (5792)` tests, 0 failed, on the first run. The transient failure T10a reported did not reproduce; no rerun was needed.
- `npx fallow` → exit 0, `0 above threshold · 15976 analyzed · maintainability 91.1 (good)`. **Gate 6 is not evidence for these paths:** `.fallowrc.json` `ignorePatterns` contains `packages/llmwiki-kg/**`, so not one added line was analyzed — the same caveat recorded in L6 and L8.

**Slice accounting.** `feat/algo-KG` is ~32k authored changed lines across 110 commits against `origin/main`, far past the ~400-line reviewable slice. That is a property of the accumulated branch and its base, not of these four commits: `498ea6b` is one new directory, `c38c035` two new files plus one export and a prompt addition, and the two `docs` commits are comment and document text. Branch splitting remains a delivery decision for the parent.

### L10 — Pipeline wiring landed

T10b, two commits: `f6cca2e` `feat(kg): use the open extraction contract on ingest` (Stage 1+2) and `00b8aea` `feat(kg): run extract-verify-classify stages on ingest` (Stages 3-8, classification, persistence).

**The stage order as implemented**, in `packages/llmwiki-kg/ts/src/routes/ingest/pipeline.ts` unless named otherwise:

1. extract candidates — `chunkAndExtract`: chunk, embed, persist chunks, then `extractGraphFromChunks(..., { contract: "open" })`.
2. verify evidence — `buildCandidateSpans` (`ingest/candidates.ts`): the quote is located in the STORED chunk the extractor read (never a search across the document, so overlapping chunks cannot shift the recorded `chunk_index`), and the `kg_evidence` provenance is built there.
3. resolve identities — `resolveIdentityKeys` over `resolveIdentities` and `loadKnownIdentities` (`ingest/request.ts`); a `matched` resolution echoes the existing row's key.
4. classify entities — `classifySpans` (`ingest/classify-stage.ts`) → `classifyCandidates`.
5. classify relations — same batch; entities and relations never gate each other.
6. validate structure and semantic compatibility — `validateDecisions` refuses a decision whose state and `canonical_type` disagree BEFORE any write, and each relation decision carries the compatibility verdict computed in the same batch.
7. consolidate and persist — `persistCandidates` (candidate rows as `pending`, stage 1) then `persistClassification` (`ingest/persist-classification.ts`): evidence rows, the decision columns, the append-only log.
8. update projections and exports — `finishIngest`: the document's `audit` blob and the Stack totals. The AKS export and the pages read the same rows at query time, so there is no second copy to invalidate; exposing the state on those read paths is T11/T12.

**Which stages run outside a transaction.** Stages 4, 5 and 6 — every classifier call. The handler takes a `TransactionRunner` instead of a connection, so the boundaries belong to the pipeline: stages 1-3 and the `pending` rows run in ONE short transaction that commits before the first classifier call, and stages 7-8 open a SECOND one for the writes and the response. Stage 2 and the identity RESOLUTION are pure; only their reads and writes touch a transaction.

**The bounded-transaction claim is proven, not described.** `routes/ingest/classification-wiring.test.ts` drives the production runner with a `ProbeJevClient` (a `ScriptedJevClient` subclass) that, at the moment `decide` is called, reads `pg_stat_activity` for this database and counts the `pending` candidate rows from a connection that is not the request's. Observed: `idle in transaction` is 0 at every one of the four classifier calls, and the stage-1 rows are already visible (3 entities + 1 relation), which is only possible because that transaction committed. The complementary negative is pinned too: classification enabled with only a request-scoped `wrap` and no runner is REFUSED with `IngestWiringError` before any stage runs (500, `MISSING_RUNNER_MESSAGE`), never degraded quietly.

**What happens when JEV is unconfigured.** Nothing fails and nothing is invented. `classificationRuntime` reports "not configured" when `TYPESAFE_API_KEY` is absent or blank; stages 4-6 are skipped; every candidate keeps the operational state `pending` that stage 1 wrote (the schema's "the classifier has not answered yet"); no `kg_classification_log` row is written; the `kg_evidence` rows are written anyway, because provenance does not depend on anybody's decision; the `classification` audit section is absent rather than zeroed; and the request answers 200 with its nine keys. Pinned end to end. A provider failure is never converted into `free_no_match` either — the decision layer turns it into `pending`/`failed` and the candidate survives (S25). A MALFORMED JEV configuration (a threshold outside `(0, 1)`, or an inverted band pair) raises instead: it would move a whole corpus's abstention rate with nothing in the log to explain it (S24).

**`verified` is never set by ingestion.** No statement in this pipeline mentions it; `routes/ingest/classification-wiring.test.ts` asserts `verified = false`, `source_kind = 'document'`, `pipeline = 'llamaindex-schema-extraction'` on every row an ingest writes, and the backfeed approve path (`routes/backfeed-approve.test.ts`, unchanged) still sets `verified = true`, `source_kind = 'backfeed'`, `pipeline = 'human-review'`.

**What is NOT fully wired, stated plainly.**

1. **`support_state` is written as it was received, which is `null`.** The semantic-support question S12 separates from textual presence is a separate Jev decision (`buildSupportRequest`), and this pipeline does not ask it: every `kg_evidence` row is `textual`, and no `support` verdict was invented. S12's second half and the `semantic` evidence kind remain unwired.
2. **The original predicate and proposed type are preserved as the extraction stage reports them, not byte-exactly.** The shared oracle-parity parser folds labels (`normalizeType`: trim, spaces to `_`, upper case), so "deja sin efecto" is stored as `DEJA_SIN_EFECTO` in both `type` and `predicate`. Its meaning and its distinctness survive (it is never `related_to`, and it is never merged with another predicate), but byte-exact original wording would require reading the raw payload, which lives in parsers this task was not allowed to modify.
3. **The classification vocabulary is `stacks.type_catalog` when the Stack has one, otherwise the documented default catalog.** A Stack that declares only the legacy `ontology` column is classified against the DEFAULT catalog. The two columns therefore keep different roles — `ontology` orients extraction, `type_catalog` is the classification vocabulary — which is a known open question rather than a hidden one.
4. **The extraction provider call still runs inside the first transaction.** That is deliberate and unchanged: the chunk rows are written in the same transaction, so an extraction outage still rolls them back exactly as before. Moving that boundary is T13's bounded-transaction work, not this wiring.
5. **The transaction shape is injectable, so some suites still run the old single-transaction path.** Suites that inject only `wrap` (the shared `createTestApp` harness and `routes/ingest-audit-merge.test.ts`) run every stage in one request transaction; the three ingest suites this task touched inject `run: createTransactionRunner(database())` and therefore exercise the production shape, and classification under the old shape is refused rather than silently tolerated. Production (`createIngestRouter()` with no deps) uses `withTransaction`, the process-wide runner.
6. **Read-path exposure (S42) and the AKS projection for free items (S37-S40) are T11/T12.** This task writes the columns and the `type_catalog`/`version` they read; it does not change what the query endpoints return.

**Gates over the combined tree, all green:** root `tsc` 0, package `tsc` 0, `npm run build` success (ESM + DTS), focused suites 122 passed / 1 skipped, `npm run test:affected` **749 passed | 3 skipped files, 5798 passed | 4 skipped tests, 0 failed**.

### L11 — The catalog stopped being an admission filter

**What the old behaviour was.** The Stack's declared vocabulary was an ADMISSION filter, not orientation. `parseTripletsWithOntology` and `admitStandaloneEntities` dropped every triplet and every standalone entity whose type or predicate the declaration did not name, and the audit recorded the loss as `ontology.rejected` counts with reason codes. `routes/ingest-ontology-e2e.test.ts` carried that contract in its own header — *"I ingested my document into a Stack with a declared ontology, and the graph I can query reflects exactly that declaration"* — and `routes/ingest-formation.test.ts` documented its cost in comments ("one unrecognised verb deleted two entities the document really named").

**Which parts of the user's request require the new behaviour.** S1 ("Conservar el conocimiento respaldado por las fuentes aunque no encaje en el catálogo de tipos configurado") and S7 ("no descartes candidatos solo por no encajar en él"), with S3 fixing what "free" may mean and S8 requiring entities with no relations. The two cannot both hold: a declaration that filters is a declaration that discards supported knowledge.

**Which assertions changed, and to what.** Rewrites only — same files, same test count in each, every other assertion (provenance, cross-stack integrity, contribution rows, response keys) kept meaningful, and a changed row count stated where it changes:

- `routes/ingest-ontology.test.ts` (16 → 17): eight tests rewritten, from "drops triplets outside the declaration" to "keeps triplets outside the declaration and preserves what the model proposed" (`writtenEntityTypes` `["COMPANY","PERSON"]` → `["ALIEN_CONSTRUCT","COMPANY","PERSON"]`; `writtenRelationTypes` `["EMPLOYS"]` → `["ACQUIRED","EMPLOYS"]`), from `ontology.rejected: 2` with reason codes to `ontology.rejected: 0` plus an `open` section with `outside_catalog: 2`, `kinds`, `samples`, `structural`, `truncations`; from `extraction.schemaViolations` to its absence (the open schema declares no `enum` for a type position to leave); the PATCH test now asserts the removed predicate is KEPT; the "samples cap" test asserts `outside_catalog: 8` with five samples; and one NEW test pins both halves of the contract at once — the ingest path is open while `extractGraphFromChunks`' default stays strict.
- `routes/ingest-ontology-e2e.test.ts` (9, count unchanged): six rewritten. "Only declared entity types through AKS" → every entity the document contributes, `ALIEN_CONSTRUCT` included; the traversal test now also asserts the free `ACQUIRED` edge is walkable from its own endpoint; the default-vocabulary control keeps `Vex`; `relationships_in_stack` 2 → 3 in the counters test; the audit test reads the `open` section; and "writes nodes but no edges" → "writes a node and an edge", `relationships_in_stack` 0 → 1.
- `routes/ingest-formation.test.ts` (16, count unchanged): FIVE tests rewritten (one more than the four named when the surface was extended, because the standalone-entity describe block carried a fifth). Edge counts 1 → 2 twice, 0 → 1 once, `entityRows` `[]` → `[Vex ALIEN_CONSTRUCT, Nobody PERSON]`, and the out-of-catalog predicate is asserted to be stored as `PARTNERS_WITH` rather than replaced.
- `routes/ingest-audit-merge.test.ts` and every other ingest suite were left untouched: their fixtures are in-vocabulary, so their blobs and counts are byte-identical.

**The strict path still exists as an explicit choice.** `buildToolSchema`, `parseTripletsWithOntology` and `admitStandaloneEntities` are unchanged and still exported; `extractGraphFromChunks` gained an optional `contract` whose DEFAULT is `strict`, so `core/extraction-graph.test.ts` and `core/ontology-prompt-wiring.test.ts` are untouched and still prove the oracle-parity behaviour. The ingest pipeline names `{ contract: "open" }` at its single call site. A default nobody uses would be a trap, so a test pins both: the production path is open, the default is closed.

**No `verified` semantics moved.** `source.verified` is still only ever set by human review or approved backfeed (`source_kind = 'backfeed'`, `pipeline = 'human-review'`), and ingestion now has a test asserting it writes `verified = false` on every row.

**One reversal to watch in later tasks.** A Stack can no longer ask for a closed graph by declaring a narrow vocabulary. The strict contract remains available to any caller that wants it programmatically, but the HTTP ingest endpoint does not expose that choice, and nothing in this feature adds one.

### L12 — T10b gaps closed: original predicate, semantic support, Stack catalog, bounded extraction

T10c. Three commits, each staging only its own paths: `1454656` `fix(kg): preserve original relation predicates and record support` (gaps 1+2), `e184ee6` `feat(kg): classify against the stack's own catalog` (gap 3), `276e13c` `perf(kg): extract outside the transaction` (gap 4). **All four gaps are closed; no gap is partial.**

**Gap 1 — the original predicate now survives verbatim (S2, S31). CLOSED.** It could not be closed inside the original surfaces: `core/graph-parse.ts:normalizeRelationType` folds the model's verb (`deja sin efecto` → `DEJA_SIN_EFECTO`) before any editable module exists, and the open path's `CatalogMismatch.proposed` is folded too. The parent extended the surface by exactly three files, and the change is purely additive:
- `core/graph-parse.ts` — `Triplet` gains `rawRelationType`, trimmed and otherwise untouched. `relationType` is unchanged and remains the only value used for matching, dedup, merge, the per-chunk budget and the `type` projection column.
- `core/extraction-types.ts` — `ExtractedRelationship` gains optional `predicate`, the raw original; absent means "the fold is all that is known".
- `core/graph-extraction.ts` — `tripletRelationship` carries `predicate: triplet.rawRelationType`; `relationshipKey` still keys on the fold, so two spellings of one verb remain one relationship and the merged entry keeps the first spelling's raw predicate.
- `routes/ingest/pipeline.ts` persists `predicate: originalPredicate(relationship)` (`predicate ?? type`); `routes/ingest/candidates.ts` uses the same value for the candidate and for the evidence quote.

Observed row for the free relation of `routes/ingest/classification.test.ts` (strict `toEqual`, so the values are exact): `type = "DEJA_SIN_EFECTO"`, `predicate = "deja sin efecto"`, `classification_state = "free_no_match"`, `canonical_type = null`, `compatibility = "indeterminate"`; the same file asserts no row carries `related_to` in `type`, `predicate` or `canonical_type`. `routes/ingest-formation.test.ts:387` (`edges[0]?.type === "PARTNERS_WITH"`) is green untouched, because `type` keeps its folded value.

Consequence worth naming: the relation's EVIDENCE QUOTE is now the raw predicate, so `deja sin efecto` is located in the prose (normalized case match) where the folded `DEJA_SIN_EFECTO` never could be — the underscores are not whitespace. Relation evidence rows therefore moved from `not_found` to located, which is what makes gap 2 possible for relations at all.

Residual, reported not fixed: entity labels keep the folded form in both `type` and `proposed_type` (`unicornio` → `UNICORNIO`). S2/S31 name relation predicates only, and S10 requires the proposal to be kept, which it is; verbatim entity spelling is not required by any spec and is not part of this task.

**Gap 2 — the semantic-support question is asked, and `support_state` is written (S12, S20). CLOSED.** New `routes/ingest/support-stage.ts` (stage 2b) runs before classification and asks `buildSupportRequest` + `interpretSupport` for every candidate whose quote WAS located, in span order. `classifySpans` passes the verdicts into `classifyCandidates({ supportStates })`, which is the input the classification stage already accepted, so `support_state` reaches entity and relation rows through the existing persistence. The new `support_state` semantics:
- `supported` / `unsupported` / `uncertain` — the classifier answered. Support is independent of classification: a `classified` entity can be `unsupported`, and a `free_no_match` relation can be `supported` (both pinned).
- NULL — the question was never answered, for either of two reasons that must not be confused with a judgement: the quote was NOT located (no question is asked at all), or the provider failed (`requestDecision` returns an operational failure and the judgement is simply absent). An outage never becomes `unsupported`.
- The claim put to the classifier is built from the candidate's own fields only (`entity "<name>" is of type "<proposed>"`, or `"<from>" <predicate> "<to>"`), so the question carries no interpretation the extractor did not make.
- Each judged candidate gets a SECOND `kg_evidence` row with `evidence_kind = 'semantic'`, sharing the candidate ref with its `textual` row, built through `withSupport` (which refuses a verdict for an unlocated quote). Unjudged candidates keep exactly one textual row.

**Gap 3 — the Stack's own catalog is used, legacy `ontology` included (S14). CLOSED.** New `core/catalog/stack-catalog.ts`:
- Resolution order, fixed: `stacks.type_catalog` (parsed and validated) → a catalog DERIVED from `stacks.ontology` → the documented default.
- Derivation: `entityTypes` and `relationshipTypes` become catalog types; a relationship's declared `domains` × `ranges` become catalog constraints; a relationship missing either list stays unconstrained rather than being enumerated (empty means "any declared type", which a catalog cannot express). Every type gets a generated definition prefixed with `UNDEFINED_TYPE_MARKER` ("Declared by the Stack ontology with no definition…"), so a generated definition is never mistaken for a declared one. The derived declaration goes through the ONE `parseTypeCatalog`, so it satisfies every invariant a stored catalog does and arrives frozen.
- The version is content-derived (`ontology-derived:<12 hex>` of the vocabulary), so two runs over the same declaration agree and a changed declaration does not — which is what a reclassification pass needs (S43). It is persisted in `catalog_version` on every row the run classifies.
- A stored catalog or ontology that does not parse RAISES instead of falling back: substituting the default would attribute a Stack's decisions to a vocabulary nobody configured. That replaces `classificationCatalog` (removed, now folded into this loader) and is pinned by a new test asserting 500 with `type catalog "entityTypes"` in the detail.
- Read-only throughout: a test asserts `stacks.type_catalog` stays NULL and `stacks.ontology` round-trips unchanged after an ingest (S16).

**Gap 4 — the extraction call moved out of the transaction (S44). LANDED, not faked.** The handler now opens THREE short transactions and every external call sits between them: (1) READ the document, its text and the resolved catalog; (2) PROVIDER STAGE — `chunkAndExtract(params, text, document)`, which now takes NO database handle at all and does chunking, embeddings, the extraction completion and description synthesis; (3) WRITE the chunks, resolve identities, build spans, write the `pending` candidate rows, commit; (4) DECISION STAGE — support questions, then classification; (5) WRITE evidence, decisions, history, audit and answer. `persistChunks(tx, chunks)` was split from the chunking for the same reason. The stack catalog is resolved in transaction 1, BEFORE the extraction call, so a broken catalog costs no provider request.

The bounded-transaction probe was extended, not replaced: `routes/ingest/classification-wiring.test.ts` now wraps the fetch stub and reads `pg_stat_activity` at the moment of EVERY provider call, so it covers the embedding request and the extraction completion as well as the seven Jev questions. Observed before the change: `['1','1']` (one connection `idle in transaction` at both provider calls). After: every moment is `0`, over a count equal to `toolCalls() + embeddingCalls()`.

One behaviour that changed and was accepted: an extraction outage no longer ROLLS BACK the chunk rows, because they are not written until extraction succeeded — the run stops before stage 3. The observable end state is the same (no chunk and no candidate rows for the failed run), and a failed extraction is more honestly "this run produced nothing" than "the transaction aborted". The `wrap`-only (non-classifying) test shape still nests all three runner calls in its single transaction, exactly as before; classification under that shape remains REFUSED by the router.

**Gates.** Run in each slice's own tree, before its commit — root `tsc` 0, package `tsc` 0, `npm run build` success (ESM + DTS), focused vitest over `routes/ingest` + `core/catalog`, `npm run test:affected` 0 failed. Slice 1: focused `122 passed | 1 skipped`, affected `5804 passed | 4 skipped`. Slice 2: focused `135 passed | 1 skipped`, affected `5817 passed | 4 skipped`. Slice 3: focused `135 passed | 1 skipped`, affected `5817 passed | 4 skipped`. Whole KG package after slice 3: `1133 passed | 4 skipped`.

**Slice-splitting note, because it is not visible from the SHAs.** Gaps 3 and 4 both modify `routes/ingest/pipeline.ts`, so the two commits were produced from two trees: slice 2 committed a pipeline carrying only the catalog adoption (built from `HEAD` plus that one wiring change, gates re-run green in that tree), and slice 3 restored the fully restructured file. Each commit is green in its own tree; no gate was ever run only over the accumulated branch.

**Still partial after this task: nothing in the four gaps.** Remaining open items belong to other tasks and are unchanged: read-path exposure (S42) and the AKS projection for free items (S37-S40) are T11/T12, reclassification/idempotence (S43) is T13, and the labeled evaluation set (S47) is T14.

### L13 — Read path and AKS projection landed

T11 and T12 landed as two commits, each staged alone from the same tree and each gated before it was committed. Together they close S37, S38, S39, S40, S41, S42 and scenario S45.14 and S45.15.

**`6727f99` `feat(kg): project free entities and relations to AKS` (T11) — the export projection.** `GET /aks/v1/export` stopped echoing stored columns. Entity `type` is the canonical type when the row is classified, else the extractor's proposal, else the reserved `Unclassified` convention (documented as an application convention, not an AKS type, so it cannot collide with a user's catalog). Relation `type` is the canonical type when classified, else the original predicate byte-for-byte — never flattened into `related_to`. One documented confidence formula, `round6(clamp01(extraction_confidence × support_factor))` with factors supported 1 / uncertain 0.75 / unsupported 0.25 / unjudged 1, drives both the emitted value AND the `min_confidence` filter, so a client never receives an item below its own threshold; it measures how strongly the source evidence corroborates the fact and reads neither the JEV probabilities nor `classification_state` (free is not false, so free items are not discounted). `source.verified` is a pure pass-through and no classification decision sets it. Relationship metadata is deliberately absent from the AKS wire: `AKSRelationship` is `additionalProperties: false`, so it stays in our own columns/tables instead of being forced into the payload.

**`757de92` `feat(kg): expose classification state in graph reads` (T12) — the read path.** Canonical `?type=` now compares `canonical_type` and returns only classified matches, with one deliberate compatibility branch: a row whose `classification_state IS NULL` — no decision was ever recorded, e.g. human-reviewed backfeed and pre-migration rows — still matches through its label, while a row with a RECORDED decision never falls back to its proposal. General queries and traversals carry no classification predicate, so classified and free nodes and edges are ordinary members of both. New closed `classification_state` filter (`classified | free | free_no_match | free_uncertain | pending | failed`, where `free` is the union of the two free states only because `pending`/`failed` are operational, not classifications) exposes free items with their reasons. The page route prepends a per-response classification notice to the markdown it returns; classified pages are byte-identical to before. Homonym resolution became deterministic — one shared resolver ordering by `case when classified then 0 else 1 end, confidence desc, id` and returning `matches = count(*) over ()`, so an ambiguous name is visible instead of silently resolved to whichever row came first.

**One `properties` key: `kg_classification`.** Both writers publish it with the identical shape and the identical `reason` vocabulary (`no_canonical_type_matched | classification_uncertain | classification_pending | classification_failed | null`): T12 builds the block in `core/graph_read.ts` (`classificationBlock`), T11 imports that same function and extends it only additively with the catalog/classifier versions and the raw JEV fields. Two writers, one key, one meaning — a consumer reading `kg_classification` from a read endpoint and from the export sees the same `state` and `reason`, and no consumer has to know which endpoint produced the block. Re-declaring the shape on the export side was rejected: two copies of one vocabulary drift, and a consumer would then have to reconcile them. A row with no recorded decision publishes NO block (its stored `properties` survive untouched), never a hollow one.

**ORDERING DEFECT — recorded, not hidden.** `6727f99` imports `CLASSIFICATION_PROPERTY_KEY` and `classificationBlock` from `core/graph_read.ts`, which is T12's work and was still uncommitted when T11 landed. `6727f99` therefore DOES NOT TYPECHECK AT THAT COMMIT IN ISOLATION; every gate — both `tsc` runs, `npm run build`, the focused suites, `test:affected` — is green only over the combined tree (T11 + T12). The combined tree is what landed and nothing was rewritten to hide it. A future bisect must land `6727f99` together with `757de92`, T12's first. The cause was a writer working against a shared tree whose base had already moved, not a deliberate dependency.

**DELIBERATE BEHAVIOUR CHANGE to flag for deployment (S41).** A row whose decision is `pending` — which is every newly ingested row when no JEV key is configured — is now EXCLUDED from a canonical `?type=` filter, because its stored `type` is only an extractor proposal, not a classification. That is exactly what S41 requires ("Los filtros por tipo canónico deben devolver únicamente coincidencias clasificadas"), but it has an operational consequence: a deployment that leaves classification unconfigured answers type filters with NOTHING for new ingests. Rows with NO recorded decision at all (`classification_state IS NULL` — human-reviewed backfeed and pre-migration rows) still match through their label, so human-verified facts keep answering type filters exactly as before. Before this change a `pending` row did answer through its label.

**Conformance was checked with a REAL validator**, never with a restated schema: `ajv/dist/2020.js` (already a dependency) compiles the vendored `packages/llmwiki-kg/ts/oracle/aks-specification-v0.1.0/SCHEMA.json` verbatim. Zero violations under `/entities` and `/relationships`. The only reported deviations are the two already documented: `aks_version` emits `0.2.0` against the vendored `const: "0.1.0"` (L4), and the schema has no null form for `/documents/N/audit`.

**No inference-rule engine existed and none was added** (S41's last two rules, pinned by a test). `subtypes`/`parentsOf` are a property of the DECLARED ontology over entity type NAMES, consulted at extraction admission in `core/ontology.ts`; nothing reads relationship rows to derive a type, and `core/graph_read.ts` does not import the ontology at all. A free relation therefore activates nothing: a free `SUBTYPE_OF` edge promotes nobody and writes nothing.

**Reversal risk worth naming.** `?entity_type=` on the export still matches the STORED `type` column, so a free entity exported as `Unclassified` is not reachable through `?entity_type=Unclassified`. The export parameter keeps its previous meaning on purpose; canonical filtering is the read path's `?type=` (T12, above), which is the supported way to ask.

**Gates over the combined tree**, run before the commits: root `npx tsc --noEmit` 0; `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit` 0; `npm run build` success (ESM Build success, DTS Build success); focused vitest over `routes/aks*`, `routes/pages*`, `routes/synthesize*` 13 files passed | 2 skipped, 129 tests passed | 3 skipped (the two `*-gateway` suites skip by design, they need a real provider), plus the synthesize consumers (`pages-classification`, `pages-synthesis`, `pages-prompts`, `stacks-create`, `stacks-update`) 5 files / 32 tests passed; `npm run test:affected` 756 passed | 3 skipped files, 5851 passed | 4 skipped tests, 0 failed. `test/viewer-server.test.ts` did not fail in this run and needed no re-run.
