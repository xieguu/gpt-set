const sent = new Set();
async function toPayload(image) {
  const source = image.currentSrc || image.src;
  if (!source || source.startsWith('data:') || sent.has(source) || image.naturalWidth < 512 || image.naturalHeight < 512) return null;
  const response = await fetch(source); const blob = await response.blob();
  if (!blob.type.startsWith('image/') || blob.size > 10 * 1024 * 1024) return null;
  const dataUrl = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
  sent.add(source);
  return { mimeType: blob.type, data: dataUrl.split(',')[1] };
}
async function inspect() {
  for (const image of document.images) {
    try { const payload = await toPayload(image); if (payload) chrome.runtime.sendMessage({ type: 'capture', payload }); } catch { /* transient ChatGPT assets are ignored */ }
  }
}
new MutationObserver(() => { inspect(); }).observe(document.documentElement, { childList: true, subtree: true });
setInterval(inspect, 3000); inspect();
