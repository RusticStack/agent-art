<!-- .toggle: label + native checkbox. -->
<script lang="ts">
  let { checked = $bindable(false), label, title, disabled = false, onchange }: {
    checked?: boolean; label: string; title?: string; disabled?: boolean; onchange?: (checked: boolean) => void;
  } = $props();
</script>

<label class={['toggle', checked && 'on']} {title}>
  <input type="checkbox" bind:checked {disabled} onchange={() => onchange?.(checked)} />{label}
</label>
