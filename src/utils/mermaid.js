let mermaidModulePromise;
let renderQueue = Promise.resolve();
let configuredTheme = null;
let diagramId = 0;

function loadMermaid() {
  mermaidModulePromise ||= import('mermaid').then(module => module.default);
  return mermaidModulePromise;
}

/**
 * Mermaid configuration is global. Serializing renders prevents a light/dark
 * theme change from racing diagrams that are already being generated.
 */
export function renderMermaidDiagram(definition, colorScheme) {
  const theme = colorScheme === 'light' ? 'default' : 'dark';
  const render = renderQueue.then(async () => {
    const mermaid = await loadMermaid();
    if (configuredTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        maxTextSize: 50_000,
        maxEdges: 500,
        theme,
      });
      configuredTheme = theme;
    }
    diagramId += 1;
    return mermaid.render(`agent-mermaid-${diagramId}`, definition);
  });

  // Malformed input should affect only its own diagram.
  renderQueue = render.then(() => undefined, () => undefined);
  return render;
}
