# Version B - Cloudflare Stream videos (v0.33.1-B.8, 1 Nov 2026)

B.3: rebuilt on v0.26.2 (live markup for category, scheme and lesson pages).

B.2 (1 Nov 2026): rebuilt on v0.24, which adds the staff passcode sign-in link
(`#/login/{userId}/{passcode}`). B.1 (30 Oct 2026) was built on v0.23.

The teacher view at v0.24 with one change: videos play from Cloudflare Stream instead of Wistia.
The root page (`/`) and the frozen demo (`/demo/`) are untouched and still play from Wistia,
so the two can be compared side by side.

## How it works

- Every player in `app.js` is built by one function, `wistia(id)`. In this build it looks the
  Wistia id up in a Wistia-to-Stream map and, when a ready Stream copy exists, renders the
  Stream player (`https://customer-q4gm0gw925cd2f03.cloudflarestream.com/<uid>/iframe`).
  Otherwise it renders the Wistia player as before, so nothing breaks while encoding finishes.
- The map is read once at start-up from `public.video_stream_map`, a read-only view over the
  migration log (`public.video_migration`), ready videos only. If the view is missing, every
  video falls back to Wistia.
- `?player=wistia` before the `#` (for example `/version-b/?player=wistia#/`) forces Wistia, for
  comparison.
- The footer says which player is in use and how many videos are mapped. Each player box
  carries `data-player="stream"` or `"wistia"`.

## The view (run once in the imoves-poc SQL editor)

```sql
create or replace view public.video_stream_map as
  select wistia_id, stream_uid
  from public.video_migration
  where stream_uid is not null and state = 'ready';

grant select on public.video_stream_map to anon, authenticated;
```

The view exposes only the id pair, which is no more than the content tables already show
(Wistia ids) plus the Stream UID needed to play the same public video.

## Source

Built by hand from the published v0.24 files (`../app.js` and friends) plus the change above;
the source of record is `web-poc/site/` in the private `imoves` repository, where the same
change should land as a `useStream` option before Phase 1 goes live. Longer term the Stream
UIDs should travel in the content tables (add the seven Stream UID fields to
`web-poc/extract/tables.json`) rather than through the migration log.
