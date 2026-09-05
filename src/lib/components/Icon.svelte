<script lang="ts" module>
  // A small, consistent stroke-icon set (24px grid, currentColor) so the whole UI
  // shares one visual language instead of mixing emoji and unicode glyphs.
  export const ICONS: Record<string, string> = {
    // views / nav
    agents:
      "<rect x='3' y='4' width='18' height='16' rx='2.2'/><path d='M7 9l3 3-3 3'/><path d='M13 15h3.5'/>",
    tasks:
      "<rect x='3' y='4' width='18' height='16' rx='2.2'/><path d='M9 4v16'/><path d='M15 4v16'/>",
    history:
      "<path d='M3 12a9 9 0 1 0 2.6-6.4L3 8'/><path d='M3 3v5h5'/><path d='M12 8v4l3 2'/>",
    notes:
      "<path d='M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z'/><path d='M14 3v5h5'/><path d='M9 12.5h6'/><path d='M9 16.5h4'/>",
    arrowRight: "<path d='M5 12h14'/><path d='M13 6l6 6-6 6'/>",
    chevronDown: "<path d='M6 9l6 6 6-6'/>",
    // actions
    plus: "<path d='M12 5v14'/><path d='M5 12h14'/>",
    edit: "<path d='M12 20h9'/><path d='M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'/>",
    trash:
      "<path d='M3 6h18'/><path d='M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'/><path d='M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'/><path d='M10 11v6'/><path d='M14 11v6'/>",
    check: "<path d='M20 6 9 17l-5-5'/>",
    checkCircle: "<path d='M21.8 10.5A10 10 0 1 1 17 3.3'/><path d='M22 5 12 15l-3-3'/>",
    sparkles:
      "<path d='M12 3l1.7 4.6a2 2 0 0 0 1.2 1.2L19.5 10.5l-4.6 1.7a2 2 0 0 0-1.2 1.2L12 18l-1.7-4.6a2 2 0 0 0-1.2-1.2L4.5 10.5l4.6-1.7a2 2 0 0 0 1.2-1.2Z'/><path d='M19 15l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6Z'/>",
    open: "<path d='M7 17 17 7'/><path d='M8 7h9v9'/>",
    restore: "<path d='M3 12a9 9 0 1 0 2.6-6.4L3 8'/><path d='M3 3v5h5'/>",
    archive:
      "<rect x='3' y='4' width='18' height='4' rx='1'/><path d='M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8'/><path d='M9.5 12h5'/>",
    terminal:
      "<rect x='2' y='4' width='20' height='16' rx='2.2'/><path d='M7 9l3 3-3 3'/><path d='M13 15h4'/>",
    close: "<path d='M18 6 6 18'/><path d='M6 6l12 12'/>",
    search: "<circle cx='11' cy='11' r='7'/><path d='M20 20l-4.3-4.3'/>",
    // split-pane controls
    columns:
      "<rect x='3' y='4' width='18' height='16' rx='2'/><path d='M12 4v16'/>",
    rows:
      "<rect x='3' y='4' width='18' height='16' rx='2'/><path d='M3 12h18'/>",
    flip:
      "<path d='M12 4v16'/><path d='M8 8 4 12l4 4'/><path d='M16 8l4 4-4 4'/>",
    grip:
      "<circle cx='9' cy='6' r='1.1' fill='currentColor' stroke='none'/><circle cx='9' cy='12' r='1.1' fill='currentColor' stroke='none'/><circle cx='9' cy='18' r='1.1' fill='currentColor' stroke='none'/><circle cx='15' cy='6' r='1.1' fill='currentColor' stroke='none'/><circle cx='15' cy='12' r='1.1' fill='currentColor' stroke='none'/><circle cx='15' cy='18' r='1.1' fill='currentColor' stroke='none'/>",
    // objects
    folder:
      "<path d='M4 6a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.4.6L12.2 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z'/>",
    branch:
      "<circle cx='6' cy='6' r='2.2'/><circle cx='6' cy='18' r='2.2'/><circle cx='18' cy='8' r='2.2'/><path d='M6 8.2v7.6'/><path d='M18 10.2a6 6 0 0 1-6 6H9'/>",
    alert:
      "<path d='M10.3 4 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0Z'/><path d='M12 9.5v4'/><path d='M12 17.2h.01'/>",
    clipboard:
      "<rect x='5' y='4' width='14' height='17' rx='2'/><path d='M9 4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V5H9Z'/><path d='M9 13l2 2 4-4'/>",
    inbox:
      "<path d='M22 12h-5l-2 3H9l-2-3H2'/><path d='M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.5Z'/>",
    // attachments
    paperclip:
      "<path d='M21.4 11.1 12 20.5a5.5 5.5 0 0 1-7.8-7.8l8.8-8.8a3.5 3.5 0 0 1 5 5l-8.8 8.8a1.5 1.5 0 0 1-2.2-2.2l8.1-8.1'/>",
    image:
      "<rect x='3' y='3' width='18' height='18' rx='2.4'/><circle cx='8.5' cy='8.5' r='1.6'/><path d='m21 15-4.6-4.6L5 21'/>",
    file: "<path d='M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z'/><path d='M14 3v5h5'/>",
    // sound
    volume:
      "<path d='M11 5 6 9H3v6h3l5 4V5Z'/><path d='M15.5 8.5a5 5 0 0 1 0 7'/><path d='M18.5 6a9 9 0 0 1 0 12'/>",
    volumeMute:
      "<path d='M11 5 6 9H3v6h3l5 4V5Z'/><path d='M16 9.5l5 5'/><path d='M21 9.5l-5 5'/>",
    settings:
      "<circle cx='12' cy='12' r='3'/><path d='M12 1v6m0 6v6'/><path d='M4.22 4.22l4.24 4.24m2.08 2.08l4.24 4.24'/><path d='M1 12h6m6 0h6'/><path d='M4.22 19.78l4.24-4.24m2.08-2.08l4.24-4.24'/><path d='M19.78 19.78l-4.24-4.24m-2.08-2.08l-4.24-4.24'/><path d='M19.78 4.22l-4.24 4.24m-2.08 2.08l-4.24 4.24'/>",
    // markdown editor
    bold: "<path d='M7 5h6a3.5 3.5 0 0 1 0 7H7z'/><path d='M7 12h7.5a3.5 3.5 0 0 1 0 7H7z'/>",
    italic: "<path d='M19 5h-7'/><path d='M12 19H5'/><path d='M15 5 9 19'/>",
    code: "<path d='M9 8l-4 4 4 4'/><path d='M15 8l4 4-4 4'/>",
    h1: "<path d='M4 6v12'/><path d='M12 6v12'/><path d='M4 12h8'/><path d='M17 10l2.5-1.5V18'/>",
    h2: "<path d='M4 6v12'/><path d='M12 6v12'/><path d='M4 12h8'/><path d='M17 9.2a2 2 0 1 1 3.2 1.6L16.5 18H21'/>",
    list: "<path d='M8 6h13'/><path d='M8 12h13'/><path d='M8 18h13'/><path d='M3.5 6h.01'/><path d='M3.5 12h.01'/><path d='M3.5 18h.01'/>",
    listOrdered: "<path d='M10 6h11'/><path d='M10 12h11'/><path d='M10 18h11'/><path d='M4 5.5 5 5v4'/><path d='M4 9h2'/><path d='M4 14.5h2v1.5H4V18h2'/>",
    quote: "<path d='M10 11H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v7a4 4 0 0 1-4 4'/><path d='M20 11h-5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v7a4 4 0 0 1-4 4'/>",
    link: "<path d='M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1'/><path d='M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1'/>",
    highlighter:
      "<path d='m9 11-6 6v3h9l3-3'/><path d='m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4'/>",
    eye: "<path d='M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z'/><circle cx='12' cy='12' r='3'/>",
    // code view (editor / review / run)
    code2:
      "<path d='M8.5 7 4 12l4.5 5'/><path d='M15.5 7 20 12l-4.5 5'/><path d='M13.5 4.5 10.5 19.5'/>",
    play: "<path d='M7 4.8v14.4a1 1 0 0 0 1.53.85l11.2-7.2a1 1 0 0 0 0-1.7L8.53 3.95A1 1 0 0 0 7 4.8Z'/>",
    stop: "<rect x='5' y='5' width='14' height='14' rx='2.2'/>",
    panelBottom:
      "<rect x='3' y='4' width='18' height='16' rx='2.2'/><path d='M3 14h18'/>",
    copy:
      "<rect x='9' y='9' width='12' height='12' rx='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/>",
    square: "<rect x='4' y='4' width='16' height='16' rx='2.4'/>",
    checkSquare:
      "<rect x='4' y='4' width='16' height='16' rx='2.4'/><path d='m8.5 12 2.5 2.5 4.5-5'/>",
    filter: "<path d='M3 5h18'/><path d='M6.5 12h11'/><path d='M10 19h4'/>",
    ellipsis: "<circle cx='5' cy='12' r='1.2'/><circle cx='12' cy='12' r='1.2'/><circle cx='19' cy='12' r='1.2'/>",
    // "expand context" affordances, borrowed from the review pane's hunk gutter
    unfold:
      "<path d='M12 3v5'/><path d='M9.5 5.5 12 3l2.5 2.5'/><path d='M12 21v-5'/><path d='M9.5 18.5 12 21l2.5-2.5'/><path d='M4 12h16'/>",
    arrowUp: "<path d='M12 19V5'/><path d='M6 11l6-6 6 6'/>",
    arrowDown: "<path d='M12 5v14'/><path d='M6 13l6 6 6-6'/>",
    chevronsUp: "<path d='m7 14 5-5 5 5'/><path d='m7 19 5-5 5 5'/>",
    chevronsDown: "<path d='m7 10 5 5 5-5'/><path d='m7 5 5 5 5-5'/>",
    sidebar: "<rect x='3' y='4' width='18' height='16' rx='2.2'/><path d='M9.5 4v16'/>",
    diff:
      "<path d='M12 4v6'/><path d='M9 7h6'/><path d='M9 17h6'/><circle cx='12' cy='12' r='9'/>",
    // board / dashboard (Tasks "Board" view toggle)
    display:
      "<rect x='3' y='3' width='7' height='9' rx='1'/><rect x='14' y='3' width='7' height='5' rx='1'/><rect x='14' y='12' width='7' height='9' rx='1'/><rect x='3' y='16' width='7' height='5' rx='1'/>",
  };
</script>

<script lang="ts">
  let {
    name,
    size = 16,
    stroke = 2,
    class: klass = "",
  }: { name: string; size?: number; stroke?: number; class?: string } = $props();
</script>

<svg
  class={klass}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html ICONS[name] ?? ""}
</svg>

<style>
  svg {
    display: block;
    flex-shrink: 0;
  }
</style>
