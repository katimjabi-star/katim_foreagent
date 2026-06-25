<script lang="ts" module>
  // Curated Lucide-style line icons, inlined as SVG path data (zero dependency).
  // 24×24 viewBox, drawn with currentColor so they inherit text colour and size.
  export const ICONS: Record<string, string> = {
    board: '<rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/>',
    project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    sessions: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    market: '<path d="M3 9 4.5 4h15L21 9"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="M9 13h6"/>',
    activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
    git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M18 10.5c0 4-4 3.5-6 5.5M6 8.5v7"/>',
    sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 14l.7 1.8 1.8.7-1.8.7L19 19l-.7-1.8-1.8-.7 1.8-.7z"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7z"/>',
    dot: '<circle cx="12" cy="12" r="5"/>',
    download: '<path d="M12 3v12"/><path d="m7 11 5 4 5-4"/><path d="M5 21h14"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    tree: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><rect x="9" y="15" width="6" height="6" rx="1"/><path d="M6 9v3a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V9M12 14v-2"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 19v3"/>',
    paperclip: '<path d="M21 11.5 12.5 20a4.5 4.5 0 0 1-6.4-6.4l8.5-8.5a3 3 0 0 1 4.2 4.2l-8.5 8.5a1.5 1.5 0 0 1-2.1-2.1l7.8-7.8"/>',
    agent: '<rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 8V4M8 3h8"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
  };
</script>

<script lang="ts">
  const { name, size = 16, stroke = 2, fill = false }: { name: string; size?: number; stroke?: number; fill?: boolean } = $props();
</script>

<svg
  class="icon"
  width={size} height={size} viewBox="0 0 24 24"
  fill={fill ? 'currentColor' : 'none'}
  stroke="currentColor" stroke-width={stroke}
  stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"
>{@html ICONS[name] ?? ICONS.dot}</svg>

<style>
  .icon { display: inline-block; flex: 0 0 auto; vertical-align: middle; }
</style>
