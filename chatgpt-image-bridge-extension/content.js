const MIN_IMAGE_SIZE = 512;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SENT_SOURCES = 256;
const MAX_RETRIES = 3;
const MAX_CONCURRENT_UPLOADS = 2;
const SCAN_DEBOUNCE_MS = 350;

const sent = new Set();
const pending = new Set();
const queue = [];

let activeUploads = 0;
let scanTimer = null;
let scanLocked = false;
let scanRequested = false;

function isSupportedSource(source) {
  if (!source) return false;
  try {
    const { protocol } = new URL(source, location.href);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'blob:';
  } catch {
    return false;
  }
}

function rememberSent(source) {
  sent.delete(source);
  sent.add(source);
  while (sent.size > MAX_SENT_SOURCES) {
    sent.delete(sent.values().next().value);
  }
}

function dataUrlFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

async function createPayload(source) {
  const response = await fetch(source);
  if (!response.ok && !source.startsWith('blob:')) {
    throw new Error(`读取图片失败：HTTP ${response.status}`);
  }

  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('资源不是图片');
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('图片超过 10 MB');

  const dataUrl = await dataUrlFromBlob(blob);
  return {
    mimeType: blob.type,
    data: String(dataUrl).split(',', 2)[1],
    sourceUrl: source,
  };
}

function sendCapture(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'capture', payload }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function retryLater(job) {
  const delay = 500 * (2 ** (job.retries - 1));
  setTimeout(() => {
    queue.push(job);
    pumpQueue();
  }, delay);
}

async function upload(job) {
  try {
    job.payload ||= await createPayload(job.source);
    const result = await sendCapture(job.payload);
    if (result?.skipped) {
      pending.delete(job.source);
      return;
    }
    if (!result?.ok) throw new Error(result?.error || '图片上传失败');

    // Only a confirmed server response becomes a permanent de-duplication entry.
    rememberSent(job.source);
    pending.delete(job.source);
  } catch (error) {
    if (job.retries < MAX_RETRIES) {
      job.retries += 1;
      retryLater(job);
      return;
    }

    pending.delete(job.source);
    console.debug('[GPT Set Image Bridge] capture failed after retries', job.source, error);
  }
}

function pumpQueue() {
  while (activeUploads < MAX_CONCURRENT_UPLOADS && queue.length > 0) {
    const job = queue.shift();
    activeUploads += 1;
    upload(job).finally(() => {
      activeUploads -= 1;
      pumpQueue();
    });
  }
}

function enqueueImage(image) {
  const source = image.currentSrc || image.src;
  const message = image.closest('[data-message-author-role]');
  if (!message || message.getAttribute('data-message-author-role') !== 'assistant') return;
  if (!isSupportedSource(source)) return;
  if (sent.has(source) || pending.has(source)) return;
  if (image.naturalWidth < MIN_IMAGE_SIZE || image.naturalHeight < MIN_IMAGE_SIZE) return;

  pending.add(source);
  queue.push({ source, payload: null, retries: 0 });
  pumpQueue();
}

async function inspectImages() {
  if (scanLocked) {
    scanRequested = true;
    return;
  }

  scanLocked = true;
  try {
    for (const image of document.images) enqueueImage(image);
  } finally {
    scanLocked = false;
    if (scanRequested) {
      scanRequested = false;
      scheduleInspect(0);
    }
  }
}

function scheduleInspect(delay = SCAN_DEBOUNCE_MS) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(inspectImages, delay);
}

new MutationObserver(() => scheduleInspect()).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'srcset'],
});

document.addEventListener('load', (event) => {
  if (event.target instanceof HTMLImageElement) scheduleInspect();
}, true);

setInterval(() => scheduleInspect(0), 5000);
scheduleInspect(0);
