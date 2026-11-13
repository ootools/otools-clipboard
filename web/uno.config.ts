import { defineConfig, presetUno } from 'unocss'

export default defineConfig({
  presets: [presetUno()],
  shortcuts: {
    'muted': 'text-[var(--clip-muted)]',
    'panel': 'bg-[var(--clip-surface)] border border-[var(--clip-border)] rounded-3',
    'row': 'flex items-center gap-2',
    'icon-box': 'shrink-0 inline-flex items-center justify-center rounded-2',
    'focus-ring': 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--clip-accent)]',
  },
})
