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

Two placeholders need real values:

- **`docs/docs.json`** — `navbar.links` points at
  `https://cortex.example.com`. Replace with the deployed frontend's URL,
  or remove the link.
- **`docs/openapi.yaml`** — the `servers` entry points at
  `https://api.cortex.example.com/api/v1`. Replace with the deployed
  backend's actual origin, so the API reference's "Try it" panel hits the
  real API.
