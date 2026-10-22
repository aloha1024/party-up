export function selectTextareaText(area: HTMLTextAreaElement) {
  area.focus();
  area.select();
  area.setSelectionRange(0, area.value.length);
  // WebKit's native click handling can collapse a readonly textarea's range
  // after the event handler. Restore it after that handling, without taking
  // focus back if the user has already moved to another control.
  requestAnimationFrame(() => {
    if (area.isConnected && document.activeElement === area)
      area.setSelectionRange(0, area.value.length);
  });
}

export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Older browsers and plain HTTP may still support the selection fallback.
    }
  }
  const area = document.createElement("textarea");
  const previous = document.activeElement;
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.left = "0";
  area.style.top = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    selectTextareaText(area);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}
