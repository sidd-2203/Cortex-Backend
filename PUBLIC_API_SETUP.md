# Public API — docs setup

The `docs/` folder is a complete Mintlify site (`docs.json`, `openapi.yaml`,
and five guide pages) for the public REST API. It's meant to be connected
directly to Mintlify's hosting, so it contains only site content — this
file is deliberately kept outside `docs/` instead.

## Preview locally

```bash
cd docs
npx mint dev
```

Opens at `http://localhost:3000`. `docs.json` and `openapi.yaml` have both
been validated (parses clean, every `$ref` resolves, all 8 `/v1` routes are
covered).

## Deploy

Go to [mintlify.com](https://mintlify.com), create a project, and connect
it to this repo with `docs/` as the docs directory — their GitHub app
deploys automatically on push after that.

## Before shipping

Both real URLs are set, no placeholders left:

- **`docs/openapi.yaml`**'s `servers` entry and every code example across
  the guide pages point at `https://cortex-backend-peach.vercel.app` — the
  API reference's "Try it" panel hits the real API.
- **`docs/docs.json`**'s `navbar.links` points at
  `https://cortex-frontend-kohl.vercel.app` — the deployed frontend app.
