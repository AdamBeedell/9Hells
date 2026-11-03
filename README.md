# 9Hells

A Reigns-style card game set in the Nine Hells. A party of four climbs from Nessus up through every layer to Avernus and out. Each card is a two-way choice, and combat also runs through cards.

This is **v0.1**: a playable demo of one layer (Nessus), with placeholder cards. The design spec lives in the Claude project as `design-spec-v0.1.md`.

## Run it on ZimaOS (Docker)

```bash
git clone https://github.com/AdamBeedell/9hells && cd 9hells
# edit docker-compose.yml: set ADMIN_PASSWORD (and the port, if 9377 is taken)
docker compose up -d --build
```

- The game is on `http://<zimaos-host>:9377`. Point cloudflared at that address.
- `./data` holds everything that changes: `9hells.db` (accounts and saves) and `content/*.json` (the cards).
- On first start, the bundled content in `content/` is copied into `./data/content/`. From then on the game reads and writes `./data/content/`, so pulling a new version never overwrites your edits. To take the new defaults, delete the files you want replaced from `./data/content/` and restart.
- `ADMIN_USER` and `ADMIN_PASSWORD` create (or reset) the admin account on every start. If you leave them unset, the first account to register becomes the admin.
- Set `ALLOW_REGISTRATION: "false"` once everyone has an account.
- Only set `COOKIE_SECURE: "true"` if you'll only ever use the HTTPS address. Logins over plain HTTP on the LAN need it set to `"false"`.

Updating: `git pull && docker compose up -d --build`.

## Develop

Requires Node 22.13 or newer. It uses the built-in `node:sqlite`, so there are no native modules.

```bash
npm install
npm run dev          # server on :3000 (tsx watch) + Vite on :5173 with /api proxied
npm test             # engine tests, including 300 randomised full runs
npm run check-content [dir]   # the content check, from the command line
npm run build && npm start    # production build, served from :3000
```

When you run locally, data goes in `./data/`. Set `ADMIN_USER` and `ADMIN_PASSWORD` in your shell to get an admin account.

## Layout

```
src/engine/   the game engine: pure, deterministic, seeded RNG, shared with the server
  engine.ts     turn loop, effects, targets, combat, death and soul ownership, EXP, rules, placement
  expr.ts       the small safe expression language used by conditions and amounts
  validate.ts   the content check (used by the admin editor and by npm run check-content)
src/server/   Fastify server: login, server-side runs, save import/export, admin content API
src/client/   Vite + plain TypeScript: game screen and admin content editor
content/      default content (placeholder cards)
test/         vitest
```

The server is authoritative. The browser sends "left" or "right", the engine resolves the turn on the server, and the client gets back a view plus a list of events (rolls, damage, level-ups) to animate.

## Writing content

Everything is in `content/*.json`, and can be edited in the browser under **Edit content** (admin accounts only). The editor runs the content check before it saves, and its **Reference** panel lists every op, target, placement and expression variable. Most of the time you'll touch three files.

**Cards** (`cards.json`)

```json
{
  "id": "devil_merchant",
  "speaker": "A rakshasa merchant",
  "text": "\"Healing draughts. Ten gold.\" {actor} counts the purse.",
  "left":  { "label": "Move on", "effects": [] },
  "right": { "label": "Buy (10 gold)", "effects": [
    { "if": "gold >= 10",
      "then": [{ "op": "addGold", "value": -10 }, { "op": "heal", "target": "party_not_dead", "value": 5 }],
      "else": [{ "op": "text", "value": "You can't afford it." }] }
  ]},
  "afterPlay": "reshuffle"
}
```

- `kind` is one of `event` (the default), `monster`, `monsterAttack`, `levelUp` or `boss`.
- `conditions` is a list of expressions. If any is false, the card goes to the bottom of the deck until they're all true.
- `weight` is the number of copies created when the card's deck is added.
- Values can be a number, dice (`"2d6+1"`) or an expression (`"self.hp / 2"`).
- Rolls: `{ "roll": { "mod": "dex", "vs": 13, "who": "actor", "visible": false }, "success": [...], "fail": [...] }`. A natural 20 always succeeds, and a natural 1 always fails.

**Monsters** carry state in `tracked`, and loop using `spawns` and `afterPlay`:

```json
"tracked": { "hp": 15, "ac": 13, "attack": 4, "damage": "1d8" },
"spawns": {
  "counter": { "template": "hound_attack", "count": 2, "place": { "shuffleTop": 3 } },
  "self":    { "place": { "below": "counter" } }
},
"afterPlay": [
  { "if": "self.hp <= 0", "do": "discard", "effects": [{ "op": "addExp", "value": 40 }] },
  { "else": true, "do": "discard", "spawn": ["counter", "self"] }
]
```

- A monster card with no `left` or `right` uses the acting character's two attacks.
- A `monsterAttack` card with no `left` or `right` uses the actor's two defences, rolled against `10 + the monster's attack`.
- Spawns resolve in the order they're listed. Use `{ "below": "counter" }` when the monster must land under its own attacks.
- An attack card whose monster has died is skipped silently.
- The `minion` tag means any hit kills it.

**Decks** (`decks.json`) list card ids. A deck with `startActive: true` starts in the main deck. The others come in through `addDeck`, which a card or a rule can do.

**Rules** (`rules.json`) fire on `afterChoice`, `levelUp`, `death`, `runStart`, `layerEnter` or `layerEnd`, when their `conditions` hold. In level-up and death rules, `bound` is the character concerned.

**Soul owners** (`soulOwners.json`) replace the default death (skull, out of the run) with their own `onDeath` effects: `resurrect`, `resurrectIn`, `resurrectAtLayer`, `replaceWith` or anything else.

**Characters** (`characters.json`) have HP, AC, ability modifiers, role tags (used by `role:cleric` targets) and four action slots. Characters marked `reserve: true` aren't in the starting party; they're used by `replaceWith`. `sound.semitone` and `sound.wave` give each character their own level-up chime.

## Rules summary (v0.1)

- **Health:** HP above 0 is alive. From 0 down to −9 the character is down and can still be saved. At −10 or below they're dead, and the death event fires.
- **Turn order:** set by an initiative roll (d20 + DEX) at the start of the run. The actor changes after every card, and anyone down or dead is skipped. `actor+1` is whoever acts next, and `actor-1` is whoever acted last.
- **EXP:** every living character gets the full award, plus 10% of it for each dead party member. Each level-up puts a choice card on top of the deck, and the first level-up adds the *Veterans* deck.
- **End of a layer:** the layer ends when the deck runs out or an exit card fires `endLayer`. In v0.1 that's the end of the demo.
