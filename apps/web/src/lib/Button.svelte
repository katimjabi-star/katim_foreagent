<script lang="ts">
  import Icon from './Icon.svelte';

  // KATIM-style primary action — flat orange block, white label, trailing arrow
  // that slides right on hover. The signature brand CTA (cf. "About Us →").
  const {
    icon, arrow = true, disabled = false, type = 'button', onclick, children,
  }: {
    icon?: string;
    arrow?: boolean;
    disabled?: boolean;
    type?: 'button' | 'submit';
    onclick?: () => void;
    children?: import('svelte').Snippet;
  } = $props();
</script>

<button class="btn-primary fa-btn" {type} {disabled} {onclick}>
  {#if icon}<Icon name={icon} size={15} />{/if}
  <span class="label">{@render children?.()}</span>
  {#if arrow}<span class="arrow"><Icon name="arrow" size={15} stroke={2.25} /></span>{/if}
</button>

<style>
  .fa-btn .arrow { display: inline-flex; transition: transform .16s ease; }
  .fa-btn:hover:not(:disabled) .arrow { transform: translateX(4px); }
</style>
