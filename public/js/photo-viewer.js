'use strict';

window.PhotoViewer = (() => {
  let dialog;
  let stage;
  let image;
  let photos = [];
  let index = 0;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let previousFocus = null;
  let gesture = null;
  const pointers = new Map();

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ''), location.origin);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function clampOffset() {
    const maxX = Math.max(0, (image.offsetWidth * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (image.offsetHeight * scale - stage.clientHeight) / 2);
    offsetX = Math.max(-maxX, Math.min(maxX, offsetX));
    offsetY = Math.max(-maxY, Math.min(maxY, offsetY));
  }

  function paintZoom() {
    clampOffset();
    image.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    image.style.cursor = scale > 1 ? 'grab' : 'zoom-in';
    dialog.querySelector('[data-viewer-action="zoom-reset"]').textContent = scale === 1 ? '适应' : `${Math.round(scale * 100)}%`;
  }

  function setScale(value) {
    scale = Math.max(1, Math.min(6, value));
    if (scale === 1) { offsetX = 0; offsetY = 0; }
    paintZoom();
  }

  function showPhoto() {
    const photo = photos[index];
    if (!photo) return;
    const url = safeUrl(photo.url);
    image.removeAttribute('src');
    image.alt = photo.caption || '旅行照片';
    setScale(1);
    dialog.querySelector('#photoViewerCount').textContent = `${index + 1} / ${photos.length}`;
    dialog.querySelector('#photoViewerCaption').textContent = [photo.caption, photo.location].filter(Boolean).join(' · ');
    dialog.querySelector('[data-viewer-action="previous"]').disabled = index === 0;
    dialog.querySelector('[data-viewer-action="next"]').disabled = index === photos.length - 1;
    const download = dialog.querySelector('#photoViewerDownload');
    download.href = url || '#';
    download.download = url ? new URL(url).pathname.split('/').pop() || 'photo' : '';
    download.hidden = !url;
    dialog.querySelector('#photoViewerStatus').textContent = url ? '原图加载中…' : '无法打开这张照片';
    if (url) image.src = url;
  }

  function move(step) {
    const next = index + step;
    if (next < 0 || next >= photos.length) return;
    pointers.clear();
    gesture = null;
    index = next;
    showPhoto();
  }

  function open(items, photoId) {
    photos = (items || []).filter(photo => photo && safeUrl(photo.url));
    if (!photos.length) return;
    index = Math.max(0, photos.findIndex(photo => photo.id === photoId));
    previousFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    showPhoto();
    dialog.querySelector('[data-viewer-action="close"]').focus();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  function distance(first, second) {
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  function resetGesture() {
    const points = [...pointers.values()];
    if (points.length === 2) {
      gesture = { kind: 'pinch', distance: distance(points[0], points[1]), scale };
    } else if (points.length === 1) {
      gesture = { kind: 'pan', x: points[0].x, y: points[0].y, offsetX, offsetY };
    } else {
      gesture = null;
    }
  }

  function init() {
    dialog = document.querySelector('#photoViewer');
    stage = dialog.querySelector('#photoViewerStage');
    image = dialog.querySelector('#photoViewerImage');

    dialog.addEventListener('click', event => {
      const control = event.target.closest('[data-viewer-action]');
      if (!control) return;
      switch (control.dataset.viewerAction) {
        case 'close': close(); break;
        case 'previous': move(-1); break;
        case 'next': move(1); break;
        case 'zoom-in': setScale(scale * 1.5); break;
        case 'zoom-out': setScale(scale / 1.5); break;
        case 'zoom-reset': setScale(1); break;
      }
    });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        move(event.key === 'ArrowLeft' ? -1 : 1);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setScale(scale * 1.5);
      } else if (event.key === '-') {
        event.preventDefault();
        setScale(scale / 1.5);
      } else if (event.key === '0') {
        event.preventDefault();
        setScale(1);
      }
    });
    dialog.addEventListener('close', () => {
      image.removeAttribute('src');
      photos = [];
      pointers.clear();
      gesture = null;
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
      previousFocus = null;
    });
    image.addEventListener('load', () => {
      dialog.querySelector('#photoViewerStatus').textContent = '';
      paintZoom();
    });
    image.addEventListener('error', () => {
      dialog.querySelector('#photoViewerStatus').textContent = '原图加载失败';
    });
    stage.addEventListener('wheel', event => {
      event.preventDefault();
      setScale(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
    }, { passive: false });
    stage.addEventListener('dblclick', () => setScale(scale === 1 ? 2 : 1));
    stage.addEventListener('pointerdown', event => {
      stage.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      resetGesture();
    });
    stage.addEventListener('pointermove', event => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...pointers.values()];
      if (points.length === 2 && gesture && gesture.kind === 'pinch' && gesture.distance > 0) {
        setScale(gesture.scale * distance(points[0], points[1]) / gesture.distance);
      } else if (points.length === 1 && gesture && gesture.kind === 'pan' && scale > 1) {
        offsetX = gesture.offsetX + points[0].x - gesture.x;
        offsetY = gesture.offsetY + points[0].y - gesture.y;
        paintZoom();
      }
    });
    const endPointer = event => {
      pointers.delete(event.pointerId);
      resetGesture();
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
    window.addEventListener('resize', paintZoom);
  }

  return { init, open, close };
})();
