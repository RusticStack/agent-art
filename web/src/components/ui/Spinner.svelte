<!-- Inline busy indicator; `label` is announced (role=status). -->
<script lang="ts">
  let { label = 'Loading', size = 14 }: { label?: string; size?: number } = $props();
</script>

<span class="spinner" role="status" aria-label={label} style:width="{size}px" style:height="{size}px"></span>

<style>
  .spinner { display: inline-block; flex: none; border: 2px solid var(--line2); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
</style>
