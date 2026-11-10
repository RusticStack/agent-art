<!-- Kind icon of an asset id in its kind colour (cleanup lists). -->
<script lang="ts">
  import Icon from '../ui/Icon.svelte';
  import { KIND_ICON_NAME, KIND_LABEL } from '@/lib/util/kinds';
  import { splitId } from '@/lib/util/ids';

  let { id }: { id: string } = $props();
  const kind = $derived(splitId(id)[0]);
</script>

<span class="cu-kicon" style:color="var(--k-{kind}, var(--k-file))" title={KIND_LABEL[kind] ?? kind}><Icon name={KIND_ICON_NAME[kind] ?? 'file'} size={14} /></span>
