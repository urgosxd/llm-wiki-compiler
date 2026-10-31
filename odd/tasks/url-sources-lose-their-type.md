# URL sources never consult their extension, so every upload is typed `web`

**Status:** open — reproduced on a live host, not yet fixed.
**Found:** 2026-10-28, by the integrating agent, after a user's document arrived
renamed and an assistant honestly reported the content as missing.

## Symptom

A document uploaded through the capability-URL seam is stored under a generated name
instead of the one in its URL:

```
source_identity  http://192.168.32.3:8080/documents/e6d20161-…/test.md
filename         untitled-d6bb19a2.md
size_bytes       20551        <- the content is intact
```

The content is **not lost**. It is renamed, so a `find **/test*.md` finds nothing, the
assistant cannot connect the source to the page, and it correctly reports that it
cannot give the content. Three symptoms, one cause.

## Cause

`detectSourceType` (`src/services/ingest/source-detection.ts:142`) branches on the
extension for everything **except** a URL:

```ts
if (!isUrl(source)) {
  const ext = path.extname(source).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TRANSCRIPT_EXTENSIONS.has(ext)) return "transcript";
  …
  return "file";
}

if (isYoutubeUrl(source)) return "transcript";
return "web";          // <- line 156: the extension is never consulted
```

So `/documents/<uuid>/<token>/test.md` is typed `web`. The web adapter then derives its
title with `article.title || "Untitled"` (`src/ingest/web.ts:39`), and the page lands as
`untitled-<hash>.md`.

## This is not a corner case

Every document delivered by URL is mis-typed, which means:

- `.pdf` by URL → `web`, not `pdf`
- `.vtt` / `.srt` by URL → `web`, not `transcript`
- `.png` / `.jpg` by URL → `web`, not `image`
- `.md` / `.txt` by URL → `web`, not `file`, so the name is generated rather than kept

For a caller whose documents arrive exclusively by URL — which is what a capability-URL
upload seam is — that is every upload, not an unusual one.

## The caller was correct, and was checked before being doubted

The reporting side verified its own half first: its documents table holds
`id=e6d20161, filename=test.md`, and its `capabilityPath()` puts the filename into the
URL path via `encodeURIComponent`, so the URL it handed over genuinely ends in
`/test.md`. The evidence points at this side.

## Fix direction

Consult the URL's path extension before falling back to `web`, reusing the
`IMAGE_EXTENSIONS` / `TRANSCRIPT_EXTENSIONS` sets already imported at
`source-detection.ts:19` — they are extension sets, not filesystem assumptions, so they
apply equally to a URL path.

Two cautions recorded because they make this non-trivial:

1. **A URL's extension is a weaker signal than a local path's.** `…/view.pdf` may serve
   HTML while `…/download?id=7` serves a PDF with no extension at all. The fallback to
   `web` must stay the default for anything unrecognised, and the sniffing already done
   for `.txt` (`looksLikeTxtTranscript`) is the model to follow: extension first,
   content as the tiebreaker, `web` only when neither decides.
2. **Content-Type would be more honest than the extension** where the fetch is ours. A
   URL can lie about its path; a response header is what the server actually sent. Worth
   checking at the same time as the extension rather than after it, since a second pass
   over the fetch is more expensive than reading both headers once.

## Why an assistant reported the content as missing

Worth recording separately, because it is not a defect. The assistant said plainly that
it could not produce the content, listed what it had verified, and offered next steps
rather than inventing an answer. That honest-failure behaviour was possible because
`query_wiki` and `wiki_status` reported truthfully. The ingest bug produced a wrong
answer about the data; the tools did not produce a wrong answer on top of it.

## Not fixed here

Left open: the extension-versus-Content-Type decision above is a contract choice about
how much a URL may be trusted, and it should be made deliberately rather than during a
live run.
