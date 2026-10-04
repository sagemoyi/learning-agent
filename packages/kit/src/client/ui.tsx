// Designed controls every page uses instead of native browser widgets (AGENTS.md, 前端).
// Looks live in the shell stylesheet (`la-btn`, `la-field-*`, `la-select-*`, …); icons are lucide
// line icons at stroke 1.75. Add a control here before using a new kind of input on a page.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { Check, ChevronDown, ChevronRight, FileText, FileUp, LoaderCircle, Minus, Plus, X } from 'lucide-react'
import type { IconComponent } from '@learning-agent/contracts/client'

const ICON = { size: 15, strokeWidth: 1.75 } as const

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'default' | 'primary' | 'quiet' | 'danger'
  readonly size?: 'sm' | 'md'
  readonly icon?: IconComponent
  /** Shows a spinner in place of the icon and blocks clicks. */
  readonly loading?: boolean
}

/** A button with only an icon is square; give it an `aria-label` (and a `title` for the tooltip). */
export function Button({ variant = 'default', size = 'md', icon: Icon, loading, className, children, disabled, type = 'button', ...rest }: ButtonProps): ReactNode {
  const iconOnly = Icon && (children === undefined || children === null || children === false)
  const classes = ['la-btn', variant !== 'default' && `la-btn-${variant}`, size === 'sm' && 'la-btn-sm', iconOnly && 'la-btn-icon', className].filter(Boolean).join(' ')
  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <LoaderCircle {...ICON} size={14} className="la-spin" /> : Icon && <Icon {...ICON} size={14} />}
      {children}
    </button>
  )
}

/**
 * For actions that are hard to take back: the first click asks in place ("question" with confirm and
 * cancel), so nothing pops up over the page. Esc or cancel goes back to the plain button.
 */
export function ConfirmButton({ question, confirm = '确认', onConfirm, children, icon, variant = 'default', size = 'md', loading, disabled }: {
  question: ReactNode
  confirm?: ReactNode
  onConfirm(): void
  children: ReactNode
  icon?: IconComponent
  variant?: 'default' | 'quiet' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
  disabled?: boolean
}): ReactNode {
  const [asking, setAsking] = useState(false)
  if (!asking || loading) {
    return <Button variant={variant} size={size} icon={icon} loading={loading} disabled={disabled} onClick={() => setAsking(true)}>{children}</Button>
  }
  return (
    <span className="la-confirm" role="group" onKeyDown={event => { if (event.key === 'Escape') setAsking(false) }}>
      <span className="la-confirm-text">{question}</span>
      <Button size="sm" variant={variant === 'danger' ? 'danger' : 'primary'} autoFocus onClick={() => { setAsking(false); onConfirm() }}>{confirm}</Button>
      <Button size="sm" variant="quiet" onClick={() => setAsking(false)}>取消</Button>
    </span>
  )
}

/** A label above a control, with an optional hint below. */
export function Field({ label, hint, grow, children }: { label: ReactNode; hint?: ReactNode; grow?: boolean; children: ReactNode }): ReactNode {
  return (
    <div className={`la-field${grow ? ' grow' : ''}`}>
      <span className="la-field-label">{label}</span>
      {children}
      {hint && <span className="la-field-hint">{hint}</span>}
    </div>
  )
}

export interface TextFieldProps {
  readonly value: string
  onChange(value: string): void
  /** Called on Enter (not while an input method is composing). */
  onEnter?(): void
  readonly icon?: IconComponent
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly width?: number | string
  readonly 'aria-label'?: string
  readonly autoFocus?: boolean
}

export function TextField({ value, onChange, onEnter, icon: Icon, width, ...rest }: TextFieldProps): ReactNode {
  return (
    <div className={`la-field-box${Icon ? ' with-icon' : ''}`} style={width === undefined ? undefined : { width }}>
      {Icon && <Icon {...ICON} className="la-field-icon" />}
      <input className="la-field-input" value={value} onChange={event => onChange(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) onEnter?.() }} {...rest} />
    </div>
  )
}

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  readonly value: string
  onChange(value: string): void
  /** Grows with its content up to `maxRows`, then scrolls. */
  readonly minRows?: number
  readonly maxRows?: number
}

export function TextArea({ value, onChange, minRows = 3, maxRows = 14, className, ...rest }: TextAreaProps): ReactNode {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const style = getComputedStyle(element)
    const line = parseFloat(style.lineHeight) || 20
    const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    element.style.height = 'auto'
    element.style.height = `${Math.min(Math.max(element.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth), line * minRows + chrome), line * maxRows + chrome)}px`
  }, [value, minRows, maxRows])
  return <textarea ref={ref} rows={minRows} className={`la-field-box la-field-area${className ? ` ${className}` : ''}`} value={value} onChange={event => onChange(event.target.value)} {...rest} />
}

export interface NumberFieldProps {
  readonly value: number
  onChange(value: number): void
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly width?: number
  readonly disabled?: boolean
  readonly 'aria-label'?: string
}

/** Whole numbers with − / + steppers; typing is checked when the field loses focus or on Enter. */
export function NumberField({ value, onChange, min, max, step = 1, width = 116, disabled, 'aria-label': label }: NumberFieldProps): ReactNode {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
  const commit = () => {
    const n = Number(text)
    if (text.trim() !== '' && Number.isFinite(n) && clamp(Math.round(n)) !== value) onChange(clamp(Math.round(n)))
    else setText(String(value))
  }
  const nudge = (delta: number) => {
    const typed = Number(text)
    const base = text.trim() && Number.isFinite(typed) ? Math.round(typed) : value
    const next = clamp(base + delta)
    setText(String(next))
    if (next !== value) onChange(next)
  }
  return (
    <div className={`la-number${disabled ? ' is-disabled' : ''}`} style={{ width }}>
      <button type="button" className="la-number-step" aria-label={`减少${label ?? ''}`} disabled={disabled || (min !== undefined && value <= min)} onMouseDown={event => event.preventDefault()} onClick={() => nudge(-step)}><Minus {...ICON} size={13} /></button>
      <input className="la-number-input" role="spinbutton" inputMode="numeric" aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} disabled={disabled} value={text}
        onChange={event => setText(event.target.value.replace(/[^\d-]/g, ''))} onBlur={commit}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') commit()
          else if (event.key === 'ArrowUp') { event.preventDefault(); nudge(step) }
          else if (event.key === 'ArrowDown') { event.preventDefault(); nudge(-step) }
        }} />
      <button type="button" className="la-number-step" aria-label={`增加${label ?? ''}`} disabled={disabled || (max !== undefined && value >= max)} onMouseDown={event => event.preventDefault()} onClick={() => nudge(step)}><Plus {...ICON} size={13} /></button>
    </div>
  )
}

export interface Choice<T extends string> {
  readonly value: T
  readonly label: ReactNode
  /** Secondary text in the list (not in the closed control). */
  readonly hint?: ReactNode
}

export interface SelectProps<T extends string> {
  readonly value: T | undefined
  readonly options: readonly Choice<T>[]
  onChange(value: T): void
  /** Shown while no option is chosen; a select used as a menu keeps `value` undefined. */
  readonly placeholder?: ReactNode
  readonly width?: number | string
  readonly disabled?: boolean
  readonly 'aria-label'?: string
}

/** Drop-down list: click or arrow keys to open, arrows/Enter to choose, Esc to close. */
export function Select<T extends string>({ value, options, onChange, placeholder = '请选择', width, disabled, 'aria-label': label }: SelectProps<T>): ReactNode {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [above, setAbove] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const id = useId()
  const selected = options.findIndex(option => option.value === value)

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  useLayoutEffect(() => {
    if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const show = () => {
    if (disabled || options.length === 0) return
    const box = root.current!.getBoundingClientRect()
    const below = window.innerHeight - box.bottom
    setAbove(below < 260 && box.top > below)
    setActive(Math.max(0, selected))
    setOpen(true)
  }
  const choose = (index: number) => { setOpen(false); onChange(options[index]!.value) }
  const keys = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show() }
      return
    }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(options.length - 1, index + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End') { event.preventDefault(); setActive(options.length - 1) }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active) }
    else if (event.key === 'Tab') setOpen(false)
  }

  return (
    <div className="la-select" ref={root} style={width === undefined ? undefined : { width }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}>
      <button type="button" className={`la-field-box la-select-trigger${open ? ' is-open' : ''}`} aria-haspopup="listbox" aria-expanded={open}
        role="combobox" aria-controls={id} aria-activedescendant={open ? `${id}-${active}` : undefined} aria-label={label} disabled={disabled} onClick={() => (open ? setOpen(false) : show())} onKeyDown={keys}>
        <span className={selected < 0 ? 'la-select-placeholder' : 'la-select-value'}>{selected < 0 ? placeholder : options[selected]!.label}</span>
        <ChevronDown {...ICON} size={14} className="la-select-chevron" />
      </button>
      {open && (
        <ul id={id} role="listbox" ref={list} aria-label={label} className={`la-popover la-select-list${above ? ' above' : ''}`}>
          {options.map((option, index) => (
            <li key={option.value} id={`${id}-${index}`} role="option" aria-selected={index === selected} data-active={index === active}
              className="la-select-option" onMouseEnter={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
              <span className="la-select-check">{index === selected && <Check {...ICON} size={14} strokeWidth={2} />}</span>
              <span className="la-select-text">{option.label}{option.hint && <span className="la-select-hint">{option.hint}</span>}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Two to four mutually exclusive choices shown side by side. */
export function Segmented<T extends string>({ value, options, onChange, disabled, 'aria-label': label }: {
  value: T
  options: readonly Choice<T>[]
  onChange(value: T): void
  disabled?: boolean
  'aria-label'?: string
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={label} className={`la-segmented${disabled ? ' is-disabled' : ''}`} onKeyDown={event => {
      const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
      if (!direction || disabled || !options.length) return
      event.preventDefault()
      const index = (options.findIndex(option => option.value === value) + direction + options.length) % options.length
      onChange(options[index]!.value)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus()
    }}>
      {options.map(option => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} tabIndex={option.value === value ? 0 : -1} disabled={disabled}
          className={`la-segment${option.value === value ? ' is-on' : ''}`} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  )
}

/** A check box; `card` makes the whole row an option card (answer choices). */
export function Checkbox({ checked, onChange, disabled, card, children }: { checked: boolean; onChange(checked: boolean): void; disabled?: boolean; card?: boolean; children?: ReactNode }): ReactNode {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled}
      className={`la-check${card ? ' la-check-card' : ''}${checked ? ' is-on' : ''}`} onClick={event => { event.stopPropagation(); onChange(!checked) }}>
      <span className="la-check-box">{checked && <Check {...ICON} size={12} strokeWidth={2.5} />}</span>
      {children !== undefined && <span className="la-check-label">{children}</span>}
    </button>
  )
}

/** A section that opens and closes under a one-line summary. */
export function Disclosure({ summary, defaultOpen = false, className, children }: { summary: ReactNode; defaultOpen?: boolean; className?: string; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`la-disclosure${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}>
      <button type="button" className="la-disclosure-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <ChevronRight {...ICON} size={14} className="la-disclosure-chevron" />
        <span>{summary}</span>
      </button>
      {open && <div className="la-disclosure-body">{children}</div>}
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Drop zone and file picker in one; shows the chosen file with a way to clear it. */
export function FileDrop({ file, onFile, accept = 'application/pdf,.pdf', maxBytes, disabled, title = '拖入 PDF，或点击选择', hint }: {
  file: File | undefined
  onFile(file: File | undefined): void
  accept?: string
  maxBytes?: number
  disabled?: boolean
  title?: ReactNode
  hint?: ReactNode
}): ReactNode {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  if (file) {
    const tooLarge = maxBytes !== undefined && file.size > maxBytes
    return (
      <div className={`la-file${tooLarge ? ' is-bad' : ''}`}>
        <span className="la-file-icon"><FileText {...ICON} size={18} /></span>
        <span className="la-file-meta">
          <span className="la-file-name" title={file.name}>{file.name}</span>
          <span className="la-file-size">{formatBytes(file.size)}{tooLarge ? ` · 超过 ${formatBytes(maxBytes)} 上限` : ''}</span>
        </span>
        <button type="button" className="la-icon-btn" aria-label="移除文件" disabled={disabled} onClick={() => onFile(undefined)}><X {...ICON} /></button>
      </div>
    )
  }
  const open = () => { if (!disabled) input.current?.click() }
  return (
    <div role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} className={`la-drop${over ? ' is-over' : ''}${disabled ? ' is-disabled' : ''}`}
      onClick={open} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } }}
      onDragOver={event => { event.preventDefault(); if (!disabled) setOver(true) }} onDragLeave={() => setOver(false)}
      onDrop={event => { event.preventDefault(); setOver(false); if (!disabled && event.dataTransfer.files[0]) onFile(event.dataTransfer.files[0]) }}>
      <span className="la-drop-icon"><FileUp {...ICON} size={20} /></span>
      <span className="la-drop-title">{title}</span>
      {hint && <span className="la-drop-hint">{hint}</span>}
      <input ref={input} type="file" accept={accept} hidden onChange={event => { const picked = event.target.files?.[0]; event.target.value = ''; if (picked) onFile(picked) }} />
    </div>
  )
}

export function Progress({ value, label }: { value: number; label?: string }): ReactNode {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div className="la-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)}>
      <div className="la-progress-bar" style={{ width: `${Math.max(2, clamped)}%` }} />
    </div>
  )
}
