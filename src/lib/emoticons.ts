// Port of iOS `Emoticons.swift` + `CosmeticPacks.swift`. Same KOLOBOK
// base table, same shortcode→asset mapping, same longest-match
// tokenizer. Cosmetic packs (Forum Classics, future smiley sets)
// layer extra emoticons on top — they get their own primary code
// (`:banana:` etc.) and live alongside the base set in the picker
// when the user has the pack equipped. Receivers can render any
// pack emoji in incoming text regardless of equip status because
// every pack's assets are bundled.
//
// Asset URLs:
//   - Kolobok base set served from `/emoticons/<name>.gif`
//   - Pack assets served from `/items/<pack-folder>/<name>.gif`
//   The catalog's `asset_ref` already encodes the right relative path
//   for items; we mirror the folder layout for packs here.

export interface EmoticonEntry {
  code: string
  asset: string
  name: string
}

export interface PaletteEntry {
  asset: string
  name: string
  primaryCode: string
}

export interface PackPalette {
  kindID: string
  /// Display name for the pack — for now we just show "Forum Classics"
  /// directly in the picker header. Could be localized later.
  name: string
  items: PaletteEntry[]
}

const RAW: Array<[string, string, string[]]> = [
  ['smile',      'Happy',          [':-)', ':)', '=)', ':smile:']],
  ['sad',        'Sad',            [':-(', ':(']],
  ['wink',       'Winking',        [';-)', ';)']],
  ['blum',       'Tongue',         [':-P', ':P', ':-p', ':p']],
  ['tease',      'Joking',         ['*JOKINGLY*']],
  ['cray',       'Crying',         [":'(", ":'((", ':((']],
  ['air_kiss',   'Kissed',         ['*KISSED*']],
  ['kiss2',      'Kiss',           [':-*', ':*']],
  ['blush',      'Embarrassed',    [':-[', ':[']],
  ['angel',      'Angel',          ['O:-)', 'O:)']],
  ['secret',     'Silent',         [':-X', ':X']],
  ['wacko',      'Confused',       [':-$', ':$']],
  ['aggressive', 'Angry',          ['>:o', '>:O']],
  ['biggrin',    'Laughing',       [':-D', ':D', ':))', ':-))']],
  ['nea',        'Pensive',        [':-\\', ':\\', ':/', ':-/']],
  ['shok',       'Shocked',        [':-O', ':O', ':-o', ':o', ':-0', ':0', '=-O']],
  ['dirol',      'Cool',           ['8-)', '8)', 'B-)', 'B)']],
  ['dance',      'Headphones',     ['[:-}', '[:-)', '[:}', '[:)']],
  ['boredom',    'Yawning',        ['*TIRED*']],
  ['bad',        'Sick',           [':-!', ':!']],
  ['stop',       'Stop',           ['*STOP*']],
  ['kissing',    'Two Kissing',    ['*KISSING*', ':**:']],
  ['diablo',     'Devil',          [']:->', ']:>', '>:)', '>:-)', '}:->']],
  ['give_rose',  'Red Rose',       ['@}->--', '@>->--', '@>->-', '@}->-', '@}-:--']],
  ['bomb',       'Bomb',           ['@=']],
  ['good',       'Thumbs Up',      ['*THUMBS UP*']],
  ['drinks',     'Drink',          ['*DRINK*']],
  ['heart',      'In Love',        ['*IN LOVE*', '<3']],
]

interface PackManifest {
  kindID: string
  name: string
  folder: string // public-relative URL prefix without trailing slash
  entries: { asset: string; name: string; primaryCode: string }[]
}

/// Cosmetic-pack manifest. Mirrors iOS `CosmeticPacks.swift` — when
/// adding a new pack, register it here AND drop the gif files into
/// `web-chat/public/<folder>/`. Asset names must be unique across
/// the whole system (kolobok + every pack) since the tokenizer keys
/// off them.
const PACK_MANIFESTS: PackManifest[] = [
  {
    kindID: 'forum_classics',
    name: 'Forum Classics',
    folder: '/items/cosm1',
    entries: [
      { asset: 'banana',   name: 'Banana dance', primaryCode: ':banana:' },
      { asset: 'coolblue', name: 'Cool blue',    primaryCode: ':coolblue:' },
      { asset: 'hail',     name: 'Hail',         primaryCode: ':hail:' },
      { asset: 'hwluxx',   name: 'Hwluxx',       primaryCode: ':hwluxx:' },
      { asset: 'mad',      name: 'Mad',          primaryCode: ':mad:' },
      { asset: 'wallbash', name: 'Wallbash',     primaryCode: ':wallbash:' },
    ],
  },
]

const KOLOBOK_FOLDER = '/emoticons'

/// asset name → public URL. Built once at module load from the kolobok
/// table + every pack manifest. Packs override kolobok if there's a
/// name clash (none today, but keeps the rule explicit).
const ASSET_URL: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const [asset] of RAW) map[asset] = `${KOLOBOK_FOLDER}/${asset}.gif`
  for (const pack of PACK_MANIFESTS) {
    for (const e of pack.entries) {
      map[e.asset] = `${pack.folder}/${e.asset}.gif`
    }
  }
  return map
})()

/// All entries (kolobok + every pack), sorted longest-code-first so
/// the tokenizer never clips a long shortcode by matching a shorter
/// prefix. Receivers tokenise pack codes whether or not the pack is
/// equipped — the assets are bundled regardless.
export const ENTRIES: EmoticonEntry[] = (() => {
  const flat: EmoticonEntry[] = []
  for (const [asset, name, codes] of RAW) {
    // Always include the `:asset:` form — that's the ONLY shape iOS/
    // Android parse (they deliberately ignore typed shortcuts like
    // `:-)` to avoid colliding with URLs/math). So the picker inserts
    // `:asset:` (see PALETTE) and we must tokenize it here too, even
    // for assets whose RAW list only has text shortcuts. The typed
    // shortcuts stay tokenizable on web for users who type them.
    const assetCode = `:${asset}:`
    const all = codes.includes(assetCode) ? codes : [...codes, assetCode]
    for (const code of all) flat.push({ code, asset, name })
  }
  for (const pack of PACK_MANIFESTS) {
    for (const e of pack.entries) {
      flat.push({ code: e.primaryCode, asset: e.asset, name: e.name })
    }
  }
  return flat.sort((a, b) => b.code.length - a.code.length)
})()

/// Picker palette for the kolobok base set — one entry per asset.
/// primaryCode is the `:asset:` form (NOT codes[0]) so a picked
/// emoticon renders on iOS/Android too — they only parse `:asset:`,
/// not typed shortcuts like `:-)`. (This was the bug where a smiley
/// sent from web showed as literal symbols on the phone.)
export const PALETTE: PaletteEntry[] = (() => {
  const seen = new Set<string>()
  const out: PaletteEntry[] = []
  for (const [asset, name] of RAW) {
    if (!seen.has(asset)) {
      seen.add(asset)
      out.push({ asset, name, primaryCode: `:${asset}:` })
    }
  }
  return out
})()

/// True when the kindID corresponds to a registered smiley pack.
/// Used by the chat composer to filter the inventory's equipped
/// items down to "things that should appear in the picker".
export function isSmileyPack(kindID: string): boolean {
  return PACK_MANIFESTS.some((p) => p.kindID === kindID)
}

/// Picker palette filtered to the user's currently-equipped packs,
/// returned as discrete sections so the renderer can put a divider
/// + label between each. Order matches `equippedKindIDs`.
export function packPalettesFor(equippedKindIDs: string[]): PackPalette[] {
  const known = new Map(PACK_MANIFESTS.map((p) => [p.kindID, p]))
  const out: PackPalette[] = []
  for (const kindID of equippedKindIDs) {
    const m = known.get(kindID)
    if (!m) continue
    out.push({ kindID, name: m.name, items: m.entries.slice() })
  }
  return out
}

/// Whole pack contents — used by the inventory sheet when a smiley
/// pack is opened so the user can see everything inside before
/// equipping. Returns null when the kindID isn't a registered pack.
export function packContentsFor(kindID: string): PackPalette | null {
  const m = PACK_MANIFESTS.find((p) => p.kindID === kindID)
  if (!m) return null
  return { kindID: m.kindID, name: m.name, items: m.entries.slice() }
}

export type Token = { kind: 'text'; text: string } | { kind: 'emoticon'; asset: string; code: string }

/// Tokenize a string into [text | emoticon] runs. Used by the
/// chat-bubble renderer to splice GIFs into the typeface flow.
export function tokenize(input: string): Token[] {
  const out: Token[] = []
  let buffer = ''
  let i = 0
  while (i < input.length) {
    let matched: EmoticonEntry | null = null
    for (const e of ENTRIES) {
      if (input.startsWith(e.code, i)) {
        matched = e
        break
      }
    }
    if (matched) {
      if (buffer) {
        out.push({ kind: 'text', text: buffer })
        buffer = ''
      }
      out.push({ kind: 'emoticon', asset: matched.asset, code: matched.code })
      i += matched.code.length
    } else {
      buffer += input[i]
      i++
    }
  }
  if (buffer) out.push({ kind: 'text', text: buffer })
  return out
}

export function emoticonAssetURL(asset: string): string {
  return ASSET_URL[asset] ?? `${KOLOBOK_FOLDER}/${asset}.gif`
}
