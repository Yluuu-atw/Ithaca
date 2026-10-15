'use strict';

const { parentPort, workerData } = require('node:worker_threads');

async function run() {
  const image = Buffer.from(workerData.image);
  if (workerData.action === 'extract') {
    const { extractWatermark } = require('./voucher-watermark');
    return extractWatermark(image);
  }
  if (workerData.action === 'compare') {
    const { compareContent } = require('./voucher-content');
    return compareContent(Buffer.from(workerData.reference), image);
  }
  throw new Error('Invalid voucher image operation');
}

run().then(value => parentPort.postMessage({ value })).catch(error => {
  parentPort.postMessage({ error: error.statusCode === 422 ? '图片格式或尺寸不支持' : '图片核验暂不可用',
    statusCode: error.statusCode === 422 ? 422 : 503 });
});
