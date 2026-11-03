// Shared types for the 9Hells engine. Content (JSON) types first, then run state.

/** A target string, e.g. "actor", "actor+1", "party_alive", "role:cleric", "char:fighter", "self", "source", "bound". */
export type Target = string;

/** A number, a dice string ("2d6+1") or an expression ("self.hp / 2"). */
export type Amount = number | string;

export interface RollSpec {
  dice?: string;            // default "1d20"
  mod?: string;             // ability modifier key on the roller, e.g. "str"
  bonus?: Amount;           // flat bonus added to the roll
  vs: Amount;               // DC: number or expression
  who?: Target;             // who rolls; default "actor"
  visible?: boolean;        // show the roll to the player (default true)
  label?: string;
}

export interface Effect {
  op?: string;
  target?: Target;
  fallback?: Target;
  value?: any;
  stat?: string;
  turns?: number;
  layer?: number;
  hp?: Amount;
  place?: Placement;
  keepOwner?: boolean;
  outcome?: "won" | "lost";   // endRun
  // roll branch
  roll?: RollSpec;
  success?: Effect[];
  fail?: Effect[];
  // conditional branch
  if?: string;
  then?: Effect[];
  else?: Effect[];
}

export type Placement =
  | "top" | "bottom" | "shuffle"
  | { at: number }
  | { shuffleTop: number | [number, number] }
  | { below: string; within?: number | [number, number] };

export interface SpawnSpec {
  template?: string;   // omit to reinsert the current instance (with its state)
  count?: number;
  place?: Placement;
  bind?: Target;       // bind a character to the spawned card ({bound})
}

export interface AfterPlayBranch {
  if?: string;
  else?: boolean;
  do?: "discard" | "reshuffle" | "once" | "requeue";
  place?: Placement;
  spawn?: string[];
  effects?: Effect[];
}

export type AfterPlay = "discard" | "reshuffle" | "once" | AfterPlayBranch[];

export interface Choice {
  label: string;
  effects?: Effect[];
}

export type CardKind = "event" | "monster" | "monsterAttack" | "levelUp" | "boss";

export interface CardTemplate {
  id: string;
  kind?: CardKind;            // default "event"
  name?: string;              // monster name
  speaker?: string;
  art?: string;
  text: string;
  tags?: string[];
  weight?: number;            // copies created when the deck is added (default 1)
  conditions?: string[];      // all must be true for the card to be played
  tracked?: Record<string, any>; // initial instance state (hp, ac, attack, damage, ...)
  spawns?: Record<string, SpawnSpec>;
  afterPlay?: AfterPlay;
  left?: Choice;
  right?: Choice;
  notes?: string;             // author notes, ignored by the engine
}

export interface DeckDef {
  id: string;
  name?: string;
  cards: string[];            // template ids
  startActive?: boolean;
}

export interface ActionDef {
  label: string;
  stat: string;               // ability modifier used
  damage?: string;            // attack actions: damage dice
  bonus?: number;             // to-hit / save bonus
  half?: boolean;             // defence: take half damage even on success? (false = none)
  onHit?: Effect[];           // attack actions: extra effects on hit (target "self" = the monster)
}

export interface ActionMod {
  id: string;
  action: ActionSlot;
  label?: string;             // replaces the label
  toHit?: number;
  damage?: string;            // extra damage dice, e.g. "1d6"
  onHit?: Effect[];
}

export type ActionSlot = "attackLeft" | "attackRight" | "defenceLeft" | "defenceRight";

export interface CharacterDef {
  id: string;
  name: string;
  roles?: string[];
  maxHp: number;
  ac: number;
  mods: Record<string, number>;
  actions: Partial<Record<ActionSlot, ActionDef>>;
  color?: string;
  sound?: { semitone?: number; wave?: OscillatorKind };
  /** Reserve characters are not in the starting party (e.g. demons used by "replaceWith"). */
  reserve?: boolean;
}
export type OscillatorKind = "sine" | "square" | "triangle" | "sawtooth";

export interface RuleDef {
  id: string;
  trigger: "afterChoice" | "levelUp" | "death" | "runStart" | "layerEnd" | "layerEnter";
  conditions?: string[];
  actions: Effect[];
  once?: boolean;
  /** Spawn specs usable by "spawn" actions in this rule. */
  spawns?: Record<string, SpawnSpec>;
}

export interface SoulOwnerDef {
  id: string;
  name: string;
  onDeath: Effect[];          // run with the dead character as "bound"
}

export interface GameConfig {
  title?: string;
  startLayer: number;
  startGold: number;
  levels: number[];            // EXP needed for level index+1, e.g. [0, 60, 150]
  downAt: number;              // HP at or below which a character is down (0)
  deadAt: number;              // HP at or below which a character is dead (-10)
  maxPendingAttacksPerMonster: number;
  catchUpPerDead: number;      // 0.1 = +10% EXP per dead member
}

export interface Content {
  config: GameConfig;
  characters: CharacterDef[];
  cards: CardTemplate[];
  decks: DeckDef[];
  rules: RuleDef[];
  soulOwners: SoulOwnerDef[];
}

// ---------------- Run state ----------------

export interface Instance {
  iid: number;
  tid: string;
  deck?: string;
  state?: Record<string, any>;
  source?: number;      // monsterAttack: iid of the monster that spawned it
  bound?: string;       // bound character id
}

export type CharStatus = "alive" | "down" | "dead";

export interface CharState {
  id: string;
  name: string;
  roles: string[];
  hp: number;
  maxHp: number;
  ac: number;
  mods: Record<string, number>;
  level: number;
  exp: number;
  status: CharStatus;
  soulOwner?: string;
  buffs: { id: string; turns?: number }[];
  actionMods: ActionMod[];
  actions: Partial<Record<ActionSlot, ActionDef>>;
  replacedBy?: string;
}

export interface PendingRes {
  charId: string;
  turns?: number;
  layer?: number;
  hp: number;
  keepOwner?: boolean;
}

export interface RollResult {
  who?: string;
  label?: string;
  natural: number;
  total: number;
  vs: number;
  success: boolean;
  margin: number;
  crit: boolean;
  fumble: boolean;
  visible: boolean;
}

export interface RunState {
  version: 1;
  seed: number;
  rng: number;
  turn: number;
  layer: number;
  status: "active" | "lost" | "won" | "layerComplete";
  endingId?: string;
  gold: number;
  flags: Record<string, any>;
  chars: CharState[];
  order: string[];               // full initiative order (all chars)
  actorIdx: number;              // pointer into order
  draw: Instance[];              // index 0 = top
  activeDecks: string[];
  current: Instance | null;
  deadMonsters: number[];
  pending: PendingRes[];
  firedRules: string[];
  seen: Record<string, number>;
  onceSeen: string[];            // templates retired across runs (merged into the user's meta)
  nextIid: number;
  lastRoll?: RollResult;
  log: string[];
}

export type GameEvent =
  | { type: "roll"; roll: RollResult }
  | { type: "damage"; who: string; amount: number; monster?: boolean }
  | { type: "heal"; who: string; amount: number }
  | { type: "levelUp"; who: string; level: number }
  | { type: "status"; who: string; status: CharStatus }
  | { type: "death"; who: string; soulOwner?: string }
  | { type: "resurrect"; who: string }
  | { type: "deck"; deck: string; added: boolean }
  | { type: "monsterDefeated"; name: string }
  | { type: "gold"; amount: number }
  | { type: "exp"; amount: number }
  | { type: "text"; text: string };

export interface CardView {
  iid: number;
  kind: CardKind;
  speaker?: string;
  name?: string;
  text: string;
  left: string;
  right: string;
  monster?: { name: string; hp: number; maxHp: number };
  tags: string[];
}

export interface RunView {
  status: RunState["status"];
  endingId?: string;
  turn: number;
  layer: number;
  gold: number;
  deckCount: number;
  actorId: string | null;
  chars: {
    id: string; name: string; roles: string[]; hp: number; maxHp: number; ac: number;
    status: CharStatus; level: number; exp: number; nextLevelExp: number | null;
    soulOwner?: string; soulOwnerName?: string; buffs: string[]; isActor: boolean;
    color?: string; sound?: CharacterDef["sound"]; pendingRes?: boolean;
  }[];
  card: CardView | null;
  log: string[];
}
