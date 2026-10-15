# Pharos Agent Lab

The landing page: an index of the Season of AI tasks, one row per built task (number, name, verb,
one line, open) and the planned ones behind one collapsed row. It is rendered from the shared task
manifest, so a new task appears by changing `shared/ui/tasks.js` and running the sync and the build.

```bash
node ../shared/ui/sync.mjs   # copy the shared UI and manifest in
npm run build                # render public/index.html from the manifest
npm test
```

A built task opens its deployment once its address is set in `DEPLOYMENTS` (`shared/ui/tasks.js`);
until then its row links to its source folder. Deploy as its own Vercel project with this folder as
the root: `npm run build`, output `public/`.
