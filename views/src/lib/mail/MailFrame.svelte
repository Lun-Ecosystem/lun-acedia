<script lang="ts">
  import { mailTheme } from './theme.ts';

  /*
   * The mail body, isolated: no script, no access to the page (no `allow-same-origin`); links open in
   * a new tab. The HTML already carries a CSP from the server, which lets inline styles through. It
   * scrolls on its own. `sombre`: a style sheet injected in the document gives it the colors of the
   * theme. `papier`: a mail laid out with its own colors keeps them, on a light rounded card.
   */
  let { html }: { html: string } = $props();

  let host = $state<HTMLElement | null>(null);
  const theme = $derived(mailTheme(html));

  /** The frame cannot read the page's tokens: their values are copied into its style sheet. */
  const sheet = $derived.by(() => {
    if (!host) return null;
    const style = getComputedStyle(host);
    const token = (name: string) => style.getPropertyValue(name).trim();
    const base =
      'img{max-width:100%;height:auto}' +
      // A plain-text mail comes wrapped in a <pre>: same font as the rest, not monospace.
      'pre{margin:0;font:inherit;white-space:pre-wrap}' +
      `body{margin:0;padding:0 2px 24px;font:300 14.5px/1.7 Inter,system-ui,sans-serif;overflow-wrap:anywhere}`;
    if (theme === 'papier')
      return `<style>:root{color-scheme:light;background:${token('--papier')}}${base}</style>`;
    return (
      '<style>' +
      `:root{color-scheme:dark}html,body{background:${token('--fond')} !important;color:${token('--papier')} !important}` +
      'body{max-width:720px}' +
      'body *{color:inherit !important;background-color:transparent !important;border-color:currentColor}' +
      `a,a *{color:${token('--accent-texte')} !important}` +
      `blockquote{margin:0 0 0 4px;padding-left:12px;border-left:2px solid ${token('--bordure-forte')}}` +
      base +
      '</style>'
    );
  });
</script>

<div class={['cadre', theme]} bind:this={host}>
  {#if sheet !== null}
    <iframe
      title="Contenu du mail"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcdoc={sheet + html}
    ></iframe>
  {/if}
</div>

<style>
  .cadre {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  iframe {
    flex: 1;
    width: 100%;
    min-height: 0;
    border: 0;
    background: transparent;
  }
  /* A laid-out mail: a light card with rounded corners in the dark interface, never a white block. */
  .papier {
    overflow: hidden;
    background: var(--papier);
    border-radius: var(--r-3);
    box-shadow: var(--ombre-1);
  }
  .papier iframe {
    padding: 8px;
  }
</style>
