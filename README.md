# Jev plays Tetris

A small web demo where [Jev](https://docs.typesafe.ai), TypeSafe's System One model, plays Tetris.
You bring your own TypeSafe API key; the page shows every decision Jev makes, with probabilities,
confidence, latency, token usage and the raw request/response.

![Jev plays Tetris](docs/screenshot.png)

## Play it

Jev mode needs a small server because `api.typesafe.ai` rejects browser origins, so the page cannot
be hosted as a static file. Two ways to get a URL:

- **Deploy to Vercel in one click.** The repo ships `api/` functions that act as the proxy and a
  `vercel.json`. Your key is entered in the page, never stored on the server.

  [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftrungdq88%2Fjev-tetris%2Ftree%2Fclaude%2Fjev-tetris-demo-dtm2mn&project-name=jev-tetris&repository-name=jev-tetris)

  Any host that runs `npm start` on a Node 20+ box (Railway, Render, Fly, a VPS) works too.
- **Run locally.** See [Run it](#run-it) below.

## How it works

Jev is not a text generator or a planner. It answers typed questions about a piece of state and
returns calibrated probabilities. So the split of work follows TypeSafe's
[building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one): code owns the
game, Jev supplies the judgment.

For every piece:

1. **Code enumerates every legal placement** (each rotation at each column, dropped straight down),
   simulates it, and computes the outcome: lines cleared, holes created, stack height, surface
   bumpiness, wells. See [`public/tetris.js`](public/tetris.js).
2. **Code turns the numbers into words.** Jev reads text and is weak at arithmetic
   ([jaggedness notes](https://docs.typesafe.ai/model-jaggedness/jev-1.13)), so each placement becomes a
   small object with the same fields on every option: `lines_cleared: "two lines"`,
   `holes_created: "none"`, `stack_height_after: "low"`, `surface_after: "flat"`, and so on.
3. **One request to `POST /v1/systemone`** carries the board as state plus four questions
   ([speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)). See [`public/jev.js`](public/jev.js).

   | Question | Type | What it does |
   | --- | --- | --- |
   | `placement` | Choice over every placement | Drives the game. The chosen option is dropped. |
   | `strategy` | Choice (`build_clean`, `clear_lines`, `repair_surface`, `survive`) | Shown as Jev's game plan. |
   | `board_health` | Score over four levels | Shown as a gauge. |
   | `next_piece_fits` | Noul | Shown as a probability bar. |

4. **Code acts on the answer.** The chosen placement is animated and locked. The full probability
   distribution is drawn on the board as ghost outlines, so you can see what Jev was torn between.
   A classic hand-tuned heuristic is computed alongside, and the panel shows how often Jev agrees with it.

The model is `jev-latest`. Each move is one request of roughly 1,000 to 2,000 input tokens, which at
the published price is a few hundredths of a cent.

## Run it

Requires Node.js 20 or newer. There are no dependencies.

```sh
npm start
# open http://localhost:3000
```

Paste your key from [console.typesafe.ai](https://console.typesafe.ai/settings/keys), press **Test**
to check it, then **Start**. Use the **Speed** slider to slow the animation down. Tick
**Remember in this browser** to keep the key in `localStorage`.

No key yet? Switch to **Built-in heuristic** to watch the code-only player. It makes no model calls.

### Why there is a server

`api.typesafe.ai` rejects browser origins (CORS), so the page cannot call it directly.
[`server.mjs`](server.mjs) serves the static files and forwards `POST /api/systemone` and
`GET /api/models` to TypeSafe with the `Authorization` header the page sent. It keeps no state and
never logs the key.

Optional environment variables:

| Variable | Meaning |
| --- | --- |
| `PORT` | Port to listen on. Default `3000`. |
| `TYPESAFE_API_KEY` | If set, visitors who leave the key field blank use this key. Leave unset for a public deployment. |
| `TYPESAFE_API_BASE` | Override the API base URL. Default `https://api.typesafe.ai`. |

Behind a corporate proxy, run with `NODE_USE_ENV_PROXY=1` so Node's `fetch` honours `HTTPS_PROXY`.

## Tests

```sh
npm test
```

Unit tests cover the engine (placement enumeration, line clears, hole counting) and the request
builder (one criteria entry per placement, stable field names, answer mapping).

## Files

```
server.mjs            local static server + TypeSafe proxy
lib/typesafe.mjs      proxy logic shared by server.mjs and api/
api/*.js              the same proxy as Vercel serverless functions
vercel.json           Vercel config (static public/, functions in api/)
public/index.html     page
public/style.css      styles
public/app.js         game loop, animation, panels
public/tetris.js      pure engine: pieces, placements, outcome descriptions
public/jev.js         request builder, API call with retry, answer mapping
test/tetris.test.mjs  node --test suite
```

## Tuning

Everything Jev sees is in `buildState` and `buildQuestions` in [`public/jev.js`](public/jev.js).
The `priorities` list inside the `placement` question is where to change how Jev weighs line clears
against holes and height. The word buckets for each feature live in the `describe*` helpers in
[`public/tetris.js`](public/tetris.js). Keep the numbers in code and hand Jev the comparison.
