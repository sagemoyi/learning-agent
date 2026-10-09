// Designed controls and page building blocks every page uses instead of native browser widgets
// (AGENTS.md, 前端). Looks live in the shell stylesheet (`la-btn`, `la-field-*`, `la-page-*`, …);
// icons are lucide line icons at stroke 1.75. Add a control here before using a new kind of input on a page.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, FileText, FileUp, Info, LoaderCircle, Minus, PlugZap, Plus, TriangleAlert, X } from 'lucide-react'
import type { IconComponent } from '@learning-agent/contracts/client'

const ICON = { size: 15, strokeWidth: 1.75 } as const

/* ── page building blocks ── */

export type PageWidth = 'reading' | 'default' | 'wide' | 'full'

/** The centered column a page lays its content in; `reading` is for long text, `wide` for grids. */
export function Page({ width = 'default', className, children }: { width?: PageWidth; className?: string; children: ReactNode }): ReactNode {
  return <div className={`la-page-inner la-w-${width}${className ? ` ${className}` : ''}`}>{children}</div>
}

/** Page title block: a small context line above, a description below, actions on the right. */
export function PageHeader({ eyebrow, title, description, meta, actions }: {
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  /** A row of tags or facts under the description. */
  meta?: ReactNode
  actions?: ReactNode
}): ReactNode {
  return (
    <header className="la-page-header">
      <div className="la-page-heading">
        {eyebrow && <div className="la-eyebrow">{eyebrow}</div>}
        <h1 className="la-page-title">{title}</h1>
        {description && <p className="la-page-desc">{description}</p>}
        {meta && <div className="la-page-meta">{meta}</div>}
      </div>
      {actions && <div className="la-page-actions">{actions}</div>}
    </header>
  )
}

/** A titled part of a page. `card` frames it; without, it is a plain group under a heading. */
export function Section({ title, icon: Icon, count, actions, description, card, className, children }: {
  title?: ReactNode
  icon?: IconComponent
  count?: number
  actions?: ReactNode
  description?: ReactNode
  card?: boolean
  className?: string
  children?: ReactNode
}): ReactNode {
  return (
    <section className={`la-section${card ? ' la-card' : ''}${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <div className="la-section-head">
          {title && <h2 className="la-section-title">{Icon && <Icon {...ICON} />}<span>{title}</span>{count !== undefined && <span className="la-count">{count}</span>}</h2>}
          {actions && <div className="la-section-actions">{actions}</div>}
        </div>
      )}
      {description && <p className="la-section-desc">{description}</p>}
      {children}
    </section>
  )
}

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad'

/** A small label: status, kind, count. */
export function Tag({ tone = 'neutral', icon: Icon, title, children }: { tone?: Tone; icon?: IconComponent; title?: string; children: ReactNode }): ReactNode {
  return <span className={`la-tag ${tone}`} title={title}>{Icon && <Icon {...ICON} size={12} />}{children}</span>
}

/** A colored dot before a status word. */
export function Dot({ tone = 'neutral', hollow }: { tone?: Tone; hollow?: boolean }): ReactNode {
  return <span className={`la-dot ${tone}${hollow ? ' hollow' : ''}`} aria-hidden />
}

const CALLOUT_ICON: Record<Tone, IconComponent> = { neutral: Info, accent: Info, ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert }

/** A boxed message: errors, notices, an action waiting for the learner. */
export function Callout({ tone = 'neutral', icon, title, actions, children }: { tone?: Tone; icon?: IconComponent | false; title?: ReactNode; actions?: ReactNode; children?: ReactNode }): ReactNode {
  const Icon = icon === false ? undefined : icon ?? CALLOUT_ICON[tone]
  return (
    <div className={`la-callout ${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      {Icon && <Icon {...ICON} size={16} className="la-callout-icon" />}
      <div className="la-callout-body">
        {title && <div className="la-callout-title">{title}</div>}
        {children && <div className="la-callout-text">{children}</div>}
      </div>
      {actions && <div className="la-callout-actions">{actions}</div>}
    </div>
  )
}

/** An error from `useLoad`/`useAction`, or nothing. */
export function ErrorText({ error }: { error: string | undefined }): ReactNode {
  return error ? <Callout tone="bad">{error}</Callout> : null
}

/** What a page or section shows when it has nothing yet. */
export function EmptyState({ icon: Icon, title, description, action, compact }: { icon?: IconComponent; title: ReactNode; description?: ReactNode; action?: ReactNode; compact?: boolean }): ReactNode {
  return (
    <div className={`la-empty-state${compact ? ' compact' : ''}`}>
      {Icon && <span className="la-empty-icon"><Icon {...ICON} size={compact ? 18 : 22} /></span>}
      <div className="la-empty-text">
        <div className="la-empty-title">{title}</div>
        {description && <div className="la-empty-desc">{description}</div>}
      </div>
      {action && <div className="la-empty-action">{action}</div>}
    </div>
  )
}

/** Grey bars standing in for content while it loads. */
export function Skeleton({ lines = 3, title }: { lines?: number; title?: boolean }): ReactNode {
  return (
    <div className="la-skeleton" aria-busy aria-label="加载中">
      {title && <span className="la-skeleton-bar title" />}
      {Array.from({ length: lines }, (_, index) => <span key={index} className="la-skeleton-bar" style={{ width: `${[92, 78, 85, 64, 88][index % 5]}%` }} />)}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }): ReactNode {
  return <kbd className="la-kbd">{children}</kbd>
}

export interface MenuItem {
  readonly key: string
  readonly label: ReactNode
  readonly icon?: IconComponent
  readonly hint?: ReactNode
  /** Shows a check (menus that choose one of several). */
  readonly checked?: boolean
  readonly danger?: boolean
  readonly disabled?: boolean
  onSelect(): void
}

export type MenuEntry = MenuItem | { readonly heading: ReactNode } | 'divider'

export interface MenuTriggerProps {
  readonly open: boolean
  readonly 'aria-haspopup': 'menu'
  readonly 'aria-expanded': boolean
  onClick(): void
}

/** A button that opens a list of actions. Arrows move, Enter chooses, Esc closes. */
export function Menu({ entries, trigger, align = 'start', width }: {
  entries: readonly MenuEntry[]
  trigger(props: MenuTriggerProps): ReactNode
  align?: 'start' | 'end'
  width?: number | string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [above, setAbove] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const items = entries.filter((entry): entry is MenuItem => typeof entry === 'object' && 'key' in entry)
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  const show = () => {
    const box = root.current!.getBoundingClientRect()
    setAbove(window.innerHeight - box.bottom < 240 && box.top > window.innerHeight - box.bottom)
    setActive(-1)
    setOpen(true)
  }
  const choose = (item: MenuItem | undefined) => {
    if (!item || item.disabled) return
    setOpen(false)
    item.onSelect()
  }
  const move = (delta: number) => {
    if (!items.length) return
    let next = active
    for (let step = 0; step < items.length; step++) {
      next = (next + delta + items.length) % items.length
      if (!items[next]!.disabled) break
    }
    setActive(next)
  }
  const keys = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (!open) {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show(); setActive(0) }
      return
    }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    else if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Enter' || event.key === ' ') { if (active >= 0) { event.preventDefault(); choose(items[active]) } }
    else if (event.key === 'Tab') setOpen(false)
  }
  return (
    <div className="la-menu" ref={root} onKeyDown={keys} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}>
      {trigger({ open, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => (open ? setOpen(false) : show()) })}
      {open && (
        <div role="menu" className={`la-popover la-menu-list${align === 'end' ? ' end' : ''}${above ? ' above' : ''}`} style={width === undefined ? undefined : { width }}>
          {entries.map((entry, index) => {
            if (entry === 'divider') return <div key={`d${index}`} className="la-menu-divider" role="separator" />
            if (!('key' in entry)) return <div key={`h${index}`} className="la-menu-heading">{entry.heading}</div>
            const position = items.indexOf(entry)
            const Icon = entry.icon
            return (
              <button key={entry.key} type="button" role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={entry.checked} disabled={entry.disabled}
                data-active={position === active} className={`la-menu-item${entry.danger ? ' danger' : ''}`}
                onMouseEnter={() => setActive(position)} onMouseDown={event => event.preventDefault()} onClick={() => choose(entry)}>
                <span className="la-menu-icon">{entry.checked ? <Check {...ICON} size={14} strokeWidth={2} /> : Icon ? <Icon {...ICON} /> : null}</span>
                <span className="la-menu-text"><span className="la-menu-label">{entry.label}</span>{entry.hint && <span className="la-menu-hint">{entry.hint}</span>}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Scroll a list so its highlighted row shows, without scrolling the page around it (unlike scrollIntoView). */
export function revealInList(list: HTMLElement | null, selector = '[data-active="true"]'): void {
  const item = list?.querySelector<HTMLElement>(selector)
  if (!list || !item) return
  const top = item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
  if (top < list.scrollTop) list.scrollTop = top
  else if (top + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + item.offsetHeight - list.clientHeight
}

/* ── controls ── */

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

/** A button that picks files; on a phone, image types offer the camera too. The file input stays hidden. */
export function PickButton({ accept, multiple, onFiles, ...button }: Omit<ButtonProps, 'onClick' | 'accept' | 'multiple'> & { accept: string; multiple?: boolean; onFiles(files: File[]): void }): ReactNode {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button {...button} onClick={event => { event.stopPropagation(); input.current?.click() }} />
      <input ref={input} type="file" accept={accept} multiple={multiple} hidden onChange={event => {
        const picked = [...(event.target.files ?? [])]
        event.target.value = ''
        if (picked.length) onFiles(picked)
      }} />
    </>
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
  /** `lg` for a page's main search box. */
  readonly size?: 'md' | 'lg'
}

export function TextField({ value, onChange, onEnter, icon: Icon, width, size = 'md', ...rest }: TextFieldProps): ReactNode {
  return (
    <div className={`la-field-box${Icon ? ' with-icon' : ''}${size === 'lg' ? ' lg' : ''}`} style={width === undefined ? undefined : { width }}>
      {Icon && <Icon {...ICON} size={size === 'lg' ? 17 : 15} className="la-field-icon" />}
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

export interface DateFieldProps {
  /** `YYYY-MM-DD`, or '' for none. */
  readonly value: string
  /** The date as `YYYY-MM-DD`, or '' while the text is empty or not a date. */
  onChange(value: string): void
  onEnter?(): void
  readonly width?: number
  readonly disabled?: boolean
  readonly 'aria-label'?: string
  readonly autoFocus?: boolean
}

/** 2027-01-10, 2027/1/10, 2027.1.10 and 2027年1月10日 → `2027-01-10`; anything else (or no such day) → undefined. */
export function normalizeDate(text: string): string | undefined {
  const match = /^\s*(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?\s*$/.exec(text)
  if (!match) return undefined
  const iso = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`
  const date = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : undefined
}

/** A typed date: no native picker, so it looks the same in every browser and theme. Marked invalid while the text is not a date. */
export function DateField({ value, onChange, onEnter, width = 150, disabled, 'aria-label': label, autoFocus }: DateFieldProps): ReactNode {
  const [text, setText] = useState(value)
  // Only an outside change replaces the text; our own onChange would otherwise reformat it mid-typing.
  useEffect(() => { if (value !== (normalizeDate(text) ?? '')) setText(value) }, [value])
  const invalid = text.trim() !== '' && !normalizeDate(text)
  return (
    <div className={`la-field-box${invalid ? ' is-invalid' : ''}`} style={{ width }}>
      <input className="la-field-input" value={text} placeholder="2027-01-10" inputMode="numeric" aria-label={label} aria-invalid={invalid} disabled={disabled} autoFocus={autoFocus}
        onChange={event => { setText(event.target.value); onChange(normalizeDate(event.target.value) ?? '') }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) onEnter?.() }} />
    </div>
  )
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
    if (open) revealInList(list.current)
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

/** An on/off setting that applies at once; for a choice inside a form or a list of options use `Checkbox`. */
export function Switch({ checked, onChange, disabled, busy, 'aria-label': label }: {
  checked: boolean
  onChange(checked: boolean): void
  disabled?: boolean
  /** The change is being saved: the switch shows the new position and waits. */
  busy?: boolean
  'aria-label': string
}): ReactNode {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} aria-busy={busy || undefined} disabled={disabled || busy}
      className={`la-switch${checked ? ' is-on' : ''}${busy ? ' is-busy' : ''}`} onClick={() => onChange(!checked)}>
      <span className="la-switch-thumb" />
    </button>
  )
}

/** Where a configured secret comes from, in words. */
function secretSource(state: { configured: boolean; source?: string; writable: boolean }): string {
  if (!state.configured) return '未填写'
  if (state.source === 'env') return '已配置：来自启动时的环境变量（.env），在这里不能修改'
  if (!state.writable) return '已配置，在这里不能修改'
  return '已配置：保存在本机'
}

/**
 * A key or other secret: the page can save or clear it but never shows it back (the store does not
 * return values). The browser is asked not to autofill a saved login password into it.
 */
export function SecretField({ state, onSave, onClear, placeholder = '粘贴新的密钥', disabled }: {
  state: { configured: boolean; source?: string; writable: boolean } | undefined
  onSave(value: string): Promise<void>
  onClear?(): Promise<void>
  placeholder?: string
  disabled?: boolean
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'save' | 'clear'>()
  const [error, setError] = useState<string>()
  const locked = !state || !state.writable || disabled
  const act = async (kind: 'save' | 'clear', action: () => Promise<void>) => {
    setBusy(kind)
    setError(undefined)
    try {
      await action()
      if (kind === 'save') setDraft('')
    } catch (caught) {
      setError(String((caught as Error)?.message ?? caught))
    } finally {
      setBusy(undefined)
    }
  }
  const save = () => { if (draft.trim() && !locked) void act('save', () => onSave(draft.trim())) }
  return (
    <div className="la-secret">
      <span className={`la-secret-state${state?.configured ? ' is-set' : ''}`}>
        <Dot tone={state?.configured ? 'ok' : 'neutral'} hollow={!state?.configured} />
        {state ? secretSource(state) : '正在读取…'}
      </span>
      {!locked && (
        <div className="la-row la-secret-edit">
          <div className="la-field-box la-secret-box">
            <input className="la-field-input" type="password" autoComplete="new-password" spellCheck={false} value={draft} placeholder={state?.configured ? '粘贴新的密钥来替换' : placeholder}
              aria-label={state?.configured ? '替换密钥' : '填写密钥'} onChange={event => setDraft(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) save() }} />
          </div>
          <Button size="sm" variant="primary" disabled={!draft.trim()} loading={busy === 'save'} onClick={save}>保存</Button>
          {state?.configured && onClear && (
            <ConfirmButton size="sm" variant="quiet" question="清除这个密钥？" confirm="清除" loading={busy === 'clear'} onConfirm={() => void act('clear', onClear)}>清除</ConfirmButton>
          )}
        </div>
      )}
      <ErrorText error={error} />
    </div>
  )
}

/** One setting: what it is on the left, its controls on the right (below it on a narrow page). Group rows in a `la-settings-card`. */
export function SettingRow({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="la-setting">
      <div className="la-setting-text">
        <div className="la-setting-title">{title}</div>
        {hint && <div className="la-setting-hint">{hint}</div>}
      </div>
      <div className="la-setting-control">{children}</div>
    </div>
  )
}

/**
 * 测试连接 and similar checks: runs `run` and shows its outcome beside the button: on success the returned
 * text, or for a number of milliseconds "连接正常（1.2 秒）"; on failure the error's message (without its code).
 */
export function TestButton({ run, children = '测试连接', disabled }: { run(): Promise<string | number>; children?: ReactNode; disabled?: boolean }): ReactNode {
  const [state, setState] = useState<{ busy?: boolean; ok?: string; error?: string }>({})
  const check = async () => {
    setState({ busy: true })
    try {
      const result = await run()
      setState({ ok: typeof result === 'string' ? result : `连接正常（${result < 100 ? '不到 0.1' : (result / 1000).toFixed(1)} 秒）` })
    } catch (caught) {
      setState({ error: String((caught as Error)?.message ?? caught) })
    }
  }
  return (
    <span className="la-test">
      <Button size="sm" icon={PlugZap} loading={state.busy} disabled={disabled} onClick={() => void check()}>{children}</Button>
      {state.ok && <span className="la-test-result" role="status"><Dot tone="ok" />{state.ok}</span>}
      {state.error && <span className="la-test-result bad" role="status"><Dot tone="bad" />{state.error}</span>}
    </span>
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
