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
| T10 | S1,S2,S3,S4,S6 | Wire the eight stages in order into `routes/ingest/pipeline.ts`; no mandatory human approval added; backfeed keeps setting `verified=true`, `source_kind='backfeed'`, `pipeline='human-review'` unchanged. | worker | `c38c035` (extraction half; wiring pending) |
| T11 | S37,S38,S39,S40 | AKS projection for free entities and relations: original predicate preserved in the export, entity extension only inside the allowed `properties`, relationship metadata kept in own columns because AKS forbids extra relationship fields, documented `confidence` formula, `source.verified` never set automatically. Scenario S45.14. | worker | `feat(kg): project free entities and relations to AKS` |
| T12 | S41,S42 | Read path: canonical-type filters return only classified matches, general queries and traversals cross both kinds, free items queryable with their reasons, classification state exposed; no rule fires on a free relation. Scenario S45.15. | worker | `feat(kg): expose classification state in graph reads` |
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
