<!-- Toolchain check only (not mounted by the app): proves Svelte 5 + TypeScript compile in this build. -->
<script lang="ts">
  let { name = 'Agent Art' }: { name?: string } = $props();
  let count = $state(1);
  const label = $derived(`${name} x${count}`);
</script>

<span class="svelte-ok">{label}</span>
