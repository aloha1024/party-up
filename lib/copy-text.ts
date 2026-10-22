export function selectTextareaText(area: HTMLTextAreaElement) {
  // WebKit can leave readonly textareas unselected when only select() is used.
  area.focus();
  area.select();
  area.setSelectionRange(0, area.value.length);
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
