/*
PPQタイミングを採用したSMFフォーマット0および1に対応しています
*/

export function readVar(bytes, state, limit = bytes.length) {
  let value = 0;
  for (let count = 0; count < 4; count++) {
    if (state.i >= limit) throw new Error("Unexpected end of MIDI variable-length value.");
    const byte = bytes[state.i++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  throw new Error("Invalid MIDI variable-length value.");
}

export function putVar(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new Error(`Invalid MIDI delta time: ${value}`);
  }
  const result = [value & 0x7f];
  while ((value = Math.floor(value / 128)) > 0) result.unshift((value & 0x7f) | 0x80);
  return result;
}

const readU32 = (b, i) => b[i] * 0x1000000 + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const readU16 = (b, i) => (b[i] << 8) | b[i + 1];
const ascii = (b, start, length) => String.fromCharCode(...b.subarray(start, start + length));

export function parseMIDI(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 14 || ascii(bytes, 0, 4) !== "MThd") throw new Error("MIDI header not found.");

  const headerLength = readU32(bytes, 4);
  if (headerLength < 6 || 8 + headerLength > bytes.length) throw new Error("Invalid MIDI header length.");
  const format = readU16(bytes, 8);
  const trackCount = readU16(bytes, 10);
  const division = readU16(bytes, 12);
  if (format > 1) throw new Error("SMF format 2 is not supported.");
  if (!trackCount) throw new Error("The MIDI file contains no tracks.");
  if (division & 0x8000) throw new Error("SMPTE time division is not supported; PPQ timing is required.");

  let offset = 8 + headerLength;
  const tracks = [];

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    if (offset + 8 > bytes.length || ascii(bytes, offset, 4) !== "MTrk") {
      throw new Error(`Track ${trackIndex + 1} chunk not found.`);
    }
    const length = readU32(bytes, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) throw new Error(`Track ${trackIndex + 1} is truncated.`);
    offset = end;

    const events = [];
    const state = { i: start };
    let tick = 0, runningStatus = 0, order = 0;

    while (state.i < end) {
      tick += readVar(bytes, state, end);
      if (state.i >= end) throw new Error("Unexpected end of track.");
      let status = bytes[state.i];
      if (status < 0x80) {
        if (!runningStatus) throw new Error("Invalid running status.");
        status = runningStatus;
      } else {
        state.i++;
        if (status < 0xf0) runningStatus = status;
        else if (status !== 0xf0 && status !== 0xf7) runningStatus = 0;
      }

      if (status === 0xff) {
        if (state.i >= end) throw new Error("Truncated meta event.");
        const type = bytes[state.i++];
        const size = readVar(bytes, state, end);
        if (state.i + size > end) throw new Error("Truncated meta event data.");
        const data = bytes.slice(state.i, state.i + size);
        state.i += size;
        events.push({ tick, kind: "meta", type, data, order: order++ });
        if (type === 0x2f) break;
      } else if (status === 0xf0 || status === 0xf7) {
        const size = readVar(bytes, state, end);
        if (state.i + size > end) throw new Error("Truncated system-exclusive event.");
        const data = bytes.slice(state.i, state.i + size);
        state.i += size;
        events.push({ tick, kind: "sysex", status, data, order: order++ });
      } else {
        const high = status & 0xf0;
        const channel = status & 0x0f;
        const size = high === 0xc0 || high === 0xd0 ? 1 : 2;
        if (state.i + size > end) throw new Error("Truncated channel event.");
        const d1 = bytes[state.i++];
        const d2 = size === 2 ? bytes[state.i++] : 0;
        events.push({ tick, kind: "channel", status, channel, high, d1, d2, order: order++ });
      }
    }

    const nameEvent = events.find(event => event.kind === "meta" && event.type === 0x03);
    const name = nameEvent ? new TextDecoder().decode(nameEvent.data) : "";
    tracks.push({ name: name || `Track ${trackIndex + 1}`, events });
  }

  return { format, division, tracks };
}

export function getNotes(track) {
  const active = new Map();
  const notes = [];
  let id = 0;

  for (const event of track.events) {
    if (event.kind !== "channel") continue;
    const isOn = event.high === 0x90 && event.d2 > 0;
    const isOff = event.high === 0x80 || (event.high === 0x90 && event.d2 === 0);
    if (!isOn && !isOff) continue;

    const key = `${event.channel}:${event.d1}`;
    if (isOn) {
      const queue = active.get(key) || [];
      queue.push({ id: id++, start: event.tick, end: null, pitch: event.d1, velocity: event.d2, channel: event.channel });
      active.set(key, queue);
    } else {
      const queue = active.get(key);
      if (queue?.length) {
        const note = queue.shift();
        note.end = event.tick;
        notes.push(note);
        if (!queue.length) active.delete(key);
      }
    }
  }

  // Ignore unmatched note-ons: their duration is unknown and must not be guessed.
  return notes.filter(note => note.end !== null && note.end > note.start);
}

/** Keep the highest active pitch in each time slice; ties favor the earliest note. */
export function cleanNotes(notes) {
  const boundaries = [...new Set(notes.flatMap(note => [note.start, note.end]))].sort((a, b) => a - b);
  const pieces = [];

  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index], end = boundaries[index + 1];
    if (end <= start) continue;
    const active = notes.filter(note => note.start < end && note.end > start);
    if (!active.length) continue;

    const highest = Math.max(...active.map(note => note.pitch));
    const winner = active
      .filter(note => note.pitch === highest)
      .sort((a, b) => a.start - b.start || a.id - b.id)[0];

    const previous = pieces.at(-1);
    if (previous && previous.id === winner.id && previous.end === start) previous.end = end;
    else pieces.push({ ...winner, start, end });
  }
  return pieces;
}

function encodeRawEvent(event) {
  if (event.kind === "meta") return [0xff, event.type, ...putVar(event.data.length), ...event.data];
  if (event.kind === "sysex") return [event.status, ...putVar(event.data.length), ...event.data];
  const data = event.high === 0xc0 || event.high === 0xd0 ? [event.d1] : [event.d1, event.d2];
  return [event.status, ...data];
}

function encodeTrack(events) {
  events.sort((a, b) => a.tick - b.tick || a.priority - b.priority || a.order - b.order);
  const output = [];
  let previousTick = 0;

  for (const event of events) {
    const delta = event.tick - previousTick;
    if (delta < 0) throw new Error("Events are not in chronological order.");
    output.push(...putVar(delta));
    previousTick = event.tick;
    if (event.kind === "raw") output.push(...event.bytes);
    else output.push(event.on ? 0x90 | event.channel : 0x80 | event.channel, event.pitch, event.on ? event.velocity : 0);
  }

  // Exactly one End-of-Track event is written, including its delta time.
  output.push(0, 0xff, 0x2f, 0);
  const size = output.length;
  return [0x4d, 0x54, 0x72, 0x6b, (size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...output];
}

const GLOBAL_META_TYPES = [0x51, 0x58, 0x59]; // tempo, time signature, key signature

/**
 * @param {object} options.keepUnselected  true: unselected tracks are written unchanged, false: they are dropped.
 */
export function writeMIDI(midi, selectedTrackIndexes, { keepUnselected = true } = {}) {
  const keptIndexes = midi.tracks.map((_, index) => index)
    .filter(index => keepUnselected || selectedTrackIndexes.has(index));
  if (!keptIndexes.length) throw new Error("出力するトラックがありません。");

  // When dropping tracks, keep tempo / time-signature / key-signature data that would otherwise be lost
  // (e.g. a conductor track in format 1) by moving it into the first output track.
  const rescued = [];
  if (!keepUnselected) {
    for (const type of GLOBAL_META_TYPES) {
      const isMeta = event => event.kind === "meta" && event.type === type;
      if (keptIndexes.some(index => midi.tracks[index].events.some(isMeta))) continue;
      midi.tracks.forEach((track, index) => {
        if (selectedTrackIndexes.has(index)) return;
        for (const event of track.events) {
          if (isMeta(event)) {
            rescued.push({ kind: "raw", tick: event.tick, priority: 1, order: event.order - 1e6, bytes: encodeRawEvent(event) });
          }
        }
      });
    }
  }

  const chunks = keptIndexes.map((trackIndex, position) => {
    const track = midi.tracks[trackIndex];
    const extra = position === 0 ? rescued : [];

    if (!selectedTrackIndexes.has(trackIndex)) {
      const events = track.events
        .filter(event => !(event.kind === "meta" && event.type === 0x2f))
        .map(event => ({ kind: "raw", tick: event.tick, priority: 1, order: event.order, bytes: encodeRawEvent(event) }));
      return encodeTrack([...events, ...extra]);
    }

    const notes = getNotes(track);
    const cleaned = cleanNotes(notes);
    const noteEvents = cleaned.flatMap(note => [
      { kind: "note", tick: note.end, on: false, channel: note.channel, pitch: note.pitch, velocity: 0, priority: 0, order: note.id },
      { kind: "note", tick: note.start, on: true, channel: note.channel, pitch: note.pitch, velocity: note.velocity, priority: 2, order: note.id }
    ]);
    const otherEvents = track.events
      .filter(event => !(event.kind === "channel" && (event.high === 0x80 || event.high === 0x90)))
      .filter(event => !(event.kind === "meta" && event.type === 0x2f))
      .map(event => ({ kind: "raw", tick: event.tick, priority: 1, order: event.order, bytes: encodeRawEvent(event) }));
    return encodeTrack([...otherEvents, ...noteEvents, ...extra]);
  });

  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
    (midi.format >>> 8) & 255, midi.format & 255,
    (chunks.length >>> 8) & 255, chunks.length & 255,
    (midi.division >>> 8) & 255, midi.division & 255];
  return new Blob([new Uint8Array([...header, ...chunks.flat()])], { type: "audio/midi" });
}