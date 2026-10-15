'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function runImageCheck(action, image, { reference, signal } = {}) {
  if (!Buffer.isBuffer(image) || !image.length || image.length > MAX_IMAGE_BYTES) {
    return Promise.reject(Object.assign(new Error('图片大小不支持'), { statusCode: 413 }));
  }
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'voucher-check-worker.js'), {
      workerData: { action, image, reference }, resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Release decoded pixels before allowing another verification request.
      worker.terminate().finally(() => error ? reject(error) : resolve(value));
    };
    const abort = () => finish(Object.assign(new Error('已取消核验'), { statusCode: 499 }));
    const timer = setTimeout(() => finish(Object.assign(new Error('核验超时，请重试'), { statusCode: 503 })), 15000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', message => message.error
      ? finish(Object.assign(new Error(message.error), { statusCode: message.statusCode }))
      : finish(null, message.value));
    worker.once('error', () => finish(Object.assign(new Error('图片核验暂不可用'), { statusCode: 503 })));
    worker.once('exit', () => { if (!settled) finish(Object.assign(new Error('图片核验中断'), { statusCode: 503 })); });
    if (signal?.aborted) abort();
  });
}

module.exports = { runImageCheck, MAX_IMAGE_BYTES };
