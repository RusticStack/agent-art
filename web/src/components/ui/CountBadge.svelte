<!-- Accent count bubble; renders nothing for 0. -->
<script lang="ts">
  let { count, label }: { count: number; /** e.g. "3 open notes", for screen readers */ label?: string } = $props();
</script>

{#if count > 0}<span class="count-badge" aria-label={label}>{count}</span>{/if}
