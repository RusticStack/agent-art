<!-- Lucide icon (a build-time SVG constant from lib/util/icons.ts; the only {@html} in the app). -->
<script lang="ts">
  import { ICONS, type IconName } from '@/lib/util/icons';

  let { name, size = 16, class: cls = '' }: { name: IconName; size?: number; class?: string } = $props();
</script>

<span class={['icon', cls]} aria-hidden="true" style:width="{size}px" style:height="{size}px">{@html ICONS[name]}</span>
