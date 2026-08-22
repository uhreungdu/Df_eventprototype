(() => {
  const DESIGN_WIDTH = 1120;
  const DESIGN_HEIGHT = 658;
  const root = document.documentElement;

  function updatePrototypeScale() {
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const rotatePortrait = width < height && width <= 900;
    const layoutWidth = rotatePortrait ? height : width;
    const layoutHeight = rotatePortrait ? width : height;
    const compact = layoutWidth <= 960;
    const remoteWidth = compact ? 0 : 212;
    const gap = compact ? 0 : 24;
    const horizontalPadding = compact ? 0 : 64;
    const verticalPadding = compact ? 0 : 96;
    const availableWidth = Math.max(1, layoutWidth - remoteWidth - gap - horizontalPadding);
    const availableHeight = Math.max(1, layoutHeight - verticalPadding);
    const scale = Math.max(0.25, Math.min(1, availableWidth / DESIGN_WIDTH, availableHeight / DESIGN_HEIGHT));

    root.style.setProperty("--prototype-scale", scale.toFixed(4));
    root.style.setProperty("--remote-width", `${remoteWidth}px`);
    root.style.setProperty("--workspace-gap", `${gap}px`);
    root.style.setProperty("--workspace-padding", `${compact ? 0 : 32}px`);
    root.style.setProperty("--rotated-workspace-width", `${layoutWidth}px`);
    root.style.setProperty("--rotated-workspace-height", `${layoutHeight}px`);
    root.dataset.compactViewport = compact ? "true" : "false";
    root.dataset.rotatePortrait = rotatePortrait ? "true" : "false";
  }

  updatePrototypeScale();
  window.addEventListener("resize", updatePrototypeScale, { passive: true });
  window.addEventListener("orientationchange", updatePrototypeScale, { passive: true });
  window.visualViewport?.addEventListener("resize", updatePrototypeScale, { passive: true });
})();
