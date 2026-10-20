<script lang="ts">
  /**
   * The mail body, isolated: no script, no access to the page (no `allow-same-origin`); links open in
   * a new tab. The HTML already carries a CSP from the server. It scrolls on its own under the bar.
   */
  let { html }: { html: string } = $props();
</script>

<iframe title="Contenu du mail" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc={html}></iframe>

<style>
  iframe {
    flex: 1;
    width: 100%;
    min-height: 0;
    border: 0;
    /* Mails are written for a light background, as in Gmail. */
    background: #fff;
    border-radius: 0 0 var(--rayon) var(--rayon);
  }
</style>
