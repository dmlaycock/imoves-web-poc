# imoves web front end - proof of concept

Teacher-facing view of the imoves content library, served as one static page over a
read-only copy of the Quickbase content tables in Supabase. No log-in, no access
rights: every live subject, category, scheme, lesson and lesson part is visible.

The page is built from `web-poc/site/index.html` in the private `imoves` repository
(`node web-poc/site/build-page.js`) and committed here for GitHub Pages to publish.
Content is refreshed from Quickbase by the "Web PoC content refresh" workflow in that
repository. The embedded Supabase key is the project's public, read-only key.

`cms/index.html` is the staff content manager proof of concept (source:
`cms-poc/site/index.html` in the `imoves` repository). Browsing is open; editing needs a
Supabase Auth login. Its database changes are applied by the "CMS PoC database" workflow in
that repository.
