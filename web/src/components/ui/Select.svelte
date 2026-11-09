<!-- Native <select> (dense, keyboard-complete); `label` is its accessible name. -->
<script lang="ts" generics="V extends string">
  let { value = $bindable(), options, label, title, disabled = false, onchange }: {
    value: V;
    options: readonly { value: V; label: string }[];
    label: string;
    title?: string;
    disabled?: boolean;
    onchange?: (value: V) => void;
  } = $props();
</script>

<select bind:value aria-label={label} {title} {disabled} onchange={() => onchange?.(value)}>
  {#each options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
</select>
