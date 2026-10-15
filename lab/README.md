# Pharos Agent Lab

The landing page: an index of the Season of AI tasks, one row per built task (number, name, verb,
one line, open) and the planned ones behind one collapsed row. It is rendered from the shared task
manifest, so a new task appears by changing `shared/ui/tasks.js` and running the sync and the build.

```bash
node ../shared/ui/sync.mjs   # copy the shared UI and manifest in
npm run build                # render public/index.html from the manifest
npm test
```

Each built task's row opens its page on the same site, `/tasks/NN`. The landing is deployed as the
root of the unified site (see `site/` and the root `vercel.json`), not on its own.
