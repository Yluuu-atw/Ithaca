'use strict';

window.PhotoAlbum = (() => {
  function dateKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return '';
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
  }

  function tripDays(trip) {
    const days = new Set((trip.itinerary || []).map(day => dateKey(day?.date)).filter(Boolean));
    const ordered = [...days].sort();
    const start = dateKey(trip.meta?.startDate) || ordered[0];
    const end = dateKey(trip.meta?.endDate) || ordered.at(-1) || start;
    if (start) days.add(start);
    if (end) days.add(end);
    if (start && end && start <= end) {
      const first = Date.parse(start + 'T00:00:00Z');
      const last = Date.parse(end + 'T00:00:00Z');
      const dayMs = 86400000;
      // Avoid filling years of empty albums if imported dates were entered incorrectly.
      if ((last - first) / dayMs <= 3660) {
        for (let stamp = first; stamp <= last; stamp += dayMs) days.add(new Date(stamp).toISOString().slice(0, 10));
      }
    }
    return [...days].sort();
  }

  function albums(trip) {
    const days = tripDays(trip);
    const byDate = new Map(days.map((date, index) => [date, { key: date, date, number: index + 1, photos: [] }]));
    for (const photo of trip.photos || []) {
      if (!photo) continue;
      const date = dateKey(photo.date);
      const key = date || 'undated';
      if (!byDate.has(key)) byDate.set(key, { key, date, number: null, photos: [] });
      byDate.get(key).photos.push(photo);
    }
    return [...byDate.values()].sort((a, b) => (b.number !== null) - (a.number !== null)
      || (a.date || '9999-12-32').localeCompare(b.date || '9999-12-32'));
  }

  async function captureDate(file, reader = window.exifr) {
    if (!reader || file.size > 20 * 1024 * 1024) return '';
    try {
      // Keep the camera's calendar date, even if the photo was taken in another timezone.
      const metadata = await reader.parse(file, { exif: { pick: [36867] }, gps: false, reviveValues: false });
      const stamp = metadata?.DateTimeOriginal;
      const match = typeof stamp === 'string' && /^(\d{4})[:-](\d{2})[:-](\d{2})(?:[T\s]|$)/.exec(stamp.trim());
      return match ? dateKey(`${match[1]}-${match[2]}-${match[3]}`) : '';
    } catch (_) {
      return '';
    }
  }

  return { dateKey, tripDays, albums, captureDate };
})();
