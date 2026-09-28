# Staging kernel responses, captured verbatim

Captured read-only on 2026-09-27 at 16:16 UTC from the staging exchange API
`https://stagenet.api-zswap.zkdojo.com` (the offer-files kernel, `ledger-v9` API shape), with
six GET requests and nothing else. Every value in them is public. They are the exact bytes the
kernel sent; do not reformat them (`.prettierignore`).

| File | Request |
|---|---|
| `offers-limit5.json` | `GET /v1/offers?limit=5` (the book was empty) |
| `pairs.json` | `GET /v1/pairs` (no pair yet) |
| `known-tokens.json` | `GET /v1/known-tokens` (NIGHT and the TW* test set; wStkA/B/C and wUSDC not registered yet) |
| `chart-stats-wstka-wusdc.json` | `GET /v1/chart/stats?base=<wStkA>&quote=<wUSDC>` (no fill, no offer: every field 0) |
| `offers-stream-first-event.txt` | the first event of `GET /v1/offers/stream` (read for 4 s) |

Response headers seen on every JSON route: `Access-Control-Allow-Origin: *`,
`x-ratelimit-limit: 600`, and no `Access-Control-Expose-Headers`, so a browser cannot read
`Retry-After` or the rate-limit headers (the client backs off exponentially instead). The
stream answered `200 text/event-stream` with `Access-Control-Allow-Origin: *`.

Because the staging book was empty, the non-empty rows used by the tests (`../book.ts`) are
built in the exact row shape of the kernel's source at `5d46e8d` (`packages/node/api.ts`,
`GET /v1/offers`, `/v1/offers/:hash`, `/v1/pairs`; `packages/node/trade-data.ts`,
`/v1/chart/stats`): amounts and heights as strings, `last_price` as a Postgres numeric string.
