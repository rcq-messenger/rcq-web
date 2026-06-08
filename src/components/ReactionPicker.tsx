// Six-asset reaction picker — KOLOBOK GIFs served from /emoticons/.
// Same six the iOS `MessageActionSheet` uses (smile, biggrin, shok,
// cray, good, heart). Tap one to fire the parent's `onPick(asset)`;
// tap the "✕" tile to clear an existing reaction. Compact strip,
// fits under a chat bubble.

const ASSETS = ['smile', 'biggrin', 'shok', 'cray', 'good', 'heart'] as const

export type ReactionAsset = (typeof ASSETS)[number]

export function ReactionPicker({
  current,
  onPick,
}: {
  /// The asset currently set on the target message, if any. Tapping
  /// the same asset toggles it off (sends `null` upstream).
  current: string | null
  onPick: (asset: string | null) => void
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1.5 shadow-sm">
      {ASSETS.map((a) => {
        const selected = current === a
        return (
          <button
            key={a}
            onClick={() => onPick(selected ? null : a)}
            className={`h-9 w-9 rounded-md flex items-center justify-center transition-colors ${
              selected ? 'bg-accent/20' : 'hover:bg-surface-dim'
            }`}
            title={a}
            aria-label={a}
          >
            <img
              src={`/emoticons/${a}.gif`}
              alt={a}
              className="h-6 w-6 select-none"
              draggable={false}
            />
          </button>
        )
      })}
    </div>
  )
}
