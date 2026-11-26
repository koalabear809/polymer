// Markers and overlays.
//
// A marker is a position in a buffer that moves as text is inserted or deleted around
// it. An overlay is a range between two markers with display properties:
//
//   const ov = makeOverlay(buf, from, to, { face: 'highlight', priority: 10 })
//   ov.set({ afterString: '  ← note', afterFace: 'dim' })
//   deleteOverlay(ov)
//
// Overlay properties:
//   face          CSS class(es) applied to the covered text
//   priority      higher wins when faces conflict (applied later)
//   beforeString  virtual text drawn before the start
//   afterString   virtual text drawn after the end
//   beforeFace / afterFace   CSS classes for the virtual text
//   lineFace      CSS class for the whole line(s) the overlay touches

export class Marker {
  /**
   * insertionType: when true, text inserted exactly at the marker goes before it
   * (the marker advances); when false (default) the marker stays put.
   */
  constructor(buffer, pos = 0, insertionType = false) {
    this.buffer = null;
    this.pos = 0;
    this.insertionType = insertionType;
    if (buffer) this.set(pos, buffer);
  }

  set(pos, buffer = this.buffer) {
    if (buffer !== this.buffer) {
      this.buffer?.markers.delete(this);
      this.buffer = buffer;
      buffer?.markers.add(this);
    }
    this.pos = buffer ? buffer.text.clamp(pos) : pos;
    return this;
  }

  get position() { return this.buffer ? this.pos : null; }

  detach() {
    this.buffer?.markers.delete(this);
    this.buffer = null;
  }

  toString() { return `#<marker at ${this.pos} in ${this.buffer?.name ?? 'no buffer'}>`; }
}

export function adjustMarkersForInsert(buf, offset, length) {
  for (const m of buf.markers) {
    if (m.pos > offset || (m.pos === offset && m.insertionType)) m.pos += length;
  }
}

export function adjustMarkersForDelete(buf, from, to) {
  const n = to - from;
  for (const m of buf.markers) {
    if (m.pos >= to) m.pos -= n;
    else if (m.pos > from) m.pos = from;
  }
}

let overlayIds = 0;

export class Overlay {
  constructor(buffer, from, to, props = {}, opts = {}) {
    this.id = ++overlayIds;
    this.buffer = buffer;
    // Emacs defaults: inserting at the start grows the overlay; at the end does not.
    this.startMarker = new Marker(buffer, Math.min(from, to), !!opts.frontAdvance);
    this.endMarker = new Marker(buffer, Math.max(from, to), !!opts.rearAdvance);
    this.props = { ...props };
    buffer.overlays.add(this);
  }

  get start() { return this.startMarker.pos; }
  get end() { return this.endMarker.pos; }
  get live() { return !!this.buffer; }

  set(props) {
    Object.assign(this.props, props);
    this.buffer?.touch();
    return this;
  }

  move(from, to) {
    this.startMarker.set(Math.min(from, to));
    this.endMarker.set(Math.max(from, to));
    this.buffer?.touch();
    return this;
  }

  toString() { return `#<overlay ${this.id} from ${this.start} to ${this.end}>`; }
}

export function makeOverlay(buffer, from, to, props, opts) {
  const ov = new Overlay(buffer, from, to, props, opts);
  buffer.touch();
  return ov;
}

export function deleteOverlay(ov) {
  const b = ov.buffer;
  if (!b) return;
  b.overlays.delete(ov);
  ov.startMarker.detach();
  ov.endMarker.detach();
  ov.buffer = null;
  b.touch();
}

/** Overlays overlapping [from, to]. Empty overlays at a boundary are included. */
export function overlaysIn(buffer, from, to) {
  const out = [];
  for (const ov of buffer.overlays) {
    if (ov.start <= to && ov.end >= from) out.push(ov);
  }
  return out;
}

/** Overlays covering `pos`. */
export function overlaysAt(buffer, pos) {
  const out = [];
  for (const ov of buffer.overlays) if (ov.start <= pos && pos < ov.end) out.push(ov);
  return out;
}
