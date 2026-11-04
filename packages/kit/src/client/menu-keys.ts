// Keyboard moves in an open menu (`Menu`, `ContextMenu` in ui.tsx), kept apart so they can be tested without React.

/**
 * Where the focus goes on a key, or undefined when the key is not a move: arrows and Home/End go over disabled items, a
 * letter goes to the next item starting with it.
 */
export function menuTarget(items: readonly { readonly label: unknown; readonly disabled?: boolean | undefined }[], active: number, key: string): number | undefined {
  const enabled = items.map((item, index) => (item.disabled ? -1 : index)).filter(index => index >= 0)
  if (!enabled.length) return undefined
  if (key === 'Home') return enabled[0]
  if (key === 'End') return enabled.at(-1)
  if (key === 'ArrowDown') return enabled.find(index => index > active) ?? enabled[0]
  if (key === 'ArrowUp') return [...enabled].reverse().find(index => index < active) ?? enabled.at(-1)
  if ([...key].length !== 1 || key === ' ') return undefined
  const starts = (index: number) => String(items[index]!.label).toLocaleLowerCase().startsWith(key.toLocaleLowerCase())
  return enabled.find(index => index > active && starts(index)) ?? enabled.find(starts)
}
