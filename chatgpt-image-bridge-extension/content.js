const MIN_IMAGE_SIZE = 512;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SENT_SOURCES = 256;
const MAX_RETRIES = 3;
const MAX_CONCURRENT_UPLOADS = 2;
const MAX_PENDING_IMAGES = 32;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const CAPTURE_TIMEOUT_MS = 25_000;
const SCAN_DEBOUNCE_MS = 350;
const SUPPORTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const sent = new Set();
const pending = new Set();
const queue = [];
const candidates = new Set();

let activeUploads = 0;
let scanTimer = null;

function imageError(message, retryable = false) {
  const error = new Error(message);
  error.retryable = retryable;
  return error;
}

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok) {
      throw imageError(`读取图片失败：HTTP ${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500);
    }
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) throw imageError('不支持的图片类型');
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw imageError('图片超过 10 MB');

    const reader = response.body?.getReader();
    let blob;
    if (reader) {
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE_BYTES) throw imageError('图片超过 10 MB');
          chunks.push(value);
        }
        blob = new Blob(chunks, { type: mimeType });
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
    } else {
      blob = await response.blob();
    }
    if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw imageError('图片必须在 1 byte 到 10 MB 之间');

    const dataUrl = await dataUrlFromBlob(blob);
    return {
      mimeType,
      data: String(dataUrl).split(',', 2)[1],
      sourceUrl: source,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function sendCapture(payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('图片上传响应超时')), CAPTURE_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage({ type: 'capture', payload }, (response) => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function upload(job) {
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        job.payload ||= await createPayload(job.source);
        const result = await sendCapture(job.payload);
        if (result?.skipped) return;
        if (!result?.ok) {
          const error = new Error(result?.error || '图片上传失败');
          error.retryable = result?.retryable !== false;
          throw error;
        }
        rememberSent(job.source);
        return;
      } catch (error) {
        if (attempt === MAX_RETRIES || error.retryable === false) {
          console.debug('[GPT Set Image Bridge] capture failed', job.source, error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      }
    }
  } finally {
    job.payload = null;
    pending.delete(job.source);
  }
}

function pumpQueue() {
  while (activeUploads < MAX_CONCURRENT_UPLOADS && queue.length > 0) {
    const job = queue.shift();
    activeUploads += 1;
    upload(job).finally(() => {
      activeUploads -= 1;
      pumpQueue();
      if (candidates.size) scheduleInspect(0);
    });
  }
}

function enqueueImage(image) {
  const source = image.currentSrc || image.src;
  const message = image.closest('[data-message-author-role]');
  if (!message || message.getAttribute('data-message-author-role') !== 'assistant') return true;
  if (!isSupportedSource(source)) return true;
  if (sent.has(source) || pending.has(source)) return true;
  if (image.naturalWidth < MIN_IMAGE_SIZE || image.naturalHeight < MIN_IMAGE_SIZE) return true;
  if (pending.size >= MAX_PENDING_IMAGES) return false;

  pending.add(source);
  queue.push({ source, payload: null });
  pumpQueue();
  return true;
}

function inspectImages() {
  scanTimer = null;
  for (const image of candidates) {
    if (image.isConnected && !enqueueImage(image)) break;
    candidates.delete(image);
  }
}

function scheduleInspect(delay = SCAN_DEBOUNCE_MS) {
  if (scanTimer !== null || !candidates.size) return;
  scanTimer = setTimeout(inspectImages, delay);
}

function collectImages(root) {
  if (root instanceof HTMLImageElement) candidates.add(root);
  else if (root.querySelectorAll) {
    for (const image of root.querySelectorAll('img')) candidates.add(image);
  }
}

new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'attributes') collectImages(mutation.target);
    else for (const node of mutation.addedNodes) collectImages(node);
  }
  scheduleInspect();
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'srcset', 'data-message-author-role'],
});

document.addEventListener('load', (event) => {
  if (event.target instanceof HTMLImageElement) {
    candidates.add(event.target);
    scheduleInspect();
  }
}, true);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !['endpoint', 'token', 'enabled'].some((key) => key in changes)) return;
  collectImages(document);
  scheduleInspect(0);
});

collectImages(document);
scheduleInspect(0);
